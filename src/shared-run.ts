// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// .gate-status/shared/ 配下のファイルで調停する:
//   - <キーのハッシュ>.<ファイル一覧のハッシュ>.run/   ロックディレクトリ。`mkdir` は原子的なので、作れた側が
//                   実行側（先着 1 名）になる。中の info.json にキー・ファイル一覧・開始時刻・タイムアウトを書く。
//   - <同じ名前>.result.json  実行側が完了時、ロックを外す前に書く結果（キーとファイル一覧付き）。
// 共有の単位はキー（root・cwd・cmd など）で、各実行は対象ファイル一覧を別に持つ。同じキーのロックが複数並び得る。
// 後から来た側は、同じキーで実行中のロックのうち実行側のファイル一覧が自分の一覧を含むもの（空の一覧はどれにも
// 含まれる）があれば、新たに起動せずロックが消えるまで待って結果を受け取る。無ければ自分で実行する。
// 完了済みの結果は再利用しない（次に同じキーが来たら実行し直す）。ロックは「開始時刻 + タイムアウト + 猶予」を
// 過ぎたら実行側が落ちたとみなして奪い直す。
import type { Io } from './io.ts'
import { join } from './path.ts'
import { isDict } from './pyutil.ts'
import { gateStatusDir } from './running-registry.ts'

export type SharedOutcome = { out: string; ok: boolean; timedOut: boolean; logpath: string }

const GRACE_MS = 5000 // 実行側が info.json を書くまでの隙間と、タイムアウト処理の余裕
const MAX_WAIT_MS = 600_000 // 1 回の待機の上限（$.process.run の上限）
const MAX_ROUNDS = 20 // 実行側の失敗が続いても待ち続けない。超えたら共有せず自分で実行する
const POLL_SECONDS = '0.05'

/** キー文字列をファイル名に使える短い 16 進にする（cyrb53）。衝突は結果の取り違えにならないよう、キー自体を結果に持たせて確かめる。 */
export function hashKey(key: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

type Hooks = { onWait?: () => void | Promise<void> }

/** ファイル一覧を昇順・重複なしにそろえる。 */
const normalizeFiles = (files: readonly string[]): string[] => [...new Set(files)].sort()

/** ロック・結果ファイルの名前の元になる、キーとファイル一覧の組のハッシュ。 */
export const shareId = (key: string, files: readonly string[]): string => `${hashKey(key)}.${hashKey(JSON.stringify(normalizeFiles(files)))}`

type Info = { started?: number; limit: number; key?: string; files?: string[] }

/** key の実行を共有する。files はこの実行が対象にするファイル一覧。戻り値の shared は「他の側の結果を受け取った」こと。 */
export async function runShared(
  io: Io,
  key: string,
  files: readonly string[],
  timeoutMs: number,
  execute: () => Promise<SharedOutcome>,
  hooks: Hooks = {},
): Promise<{ outcome: SharedOutcome; shared: boolean }> {
  const mine = normalizeFiles(files)
  const dir = join(gateStatusDir(io), 'shared')
  const keyPrefix = `${hashKey(key)}.`
  const ownLock = join(dir, `${shareId(key, mine)}.run`)
  const resultOf = (lock: string): string => `${lock.slice(0, -'.run'.length)}.result.json`

  const claim = async (): Promise<boolean> => (await io.run(['sh', '-c', 'mkdir -p "$1" && mkdir "$2"', 'sh', dir, ownLock])).exitCode === 0

  const lead = async (): Promise<SharedOutcome> => {
    const resultFile = resultOf(ownLock)
    await io.writeFile(join(ownLock, 'info.json'), JSON.stringify({ started: await io.now(), timeoutMs, key, files: mine }))
    await io.removeFiles([resultFile])
    try {
      const outcome = await execute()
      await io.writeFile(resultFile, JSON.stringify({ key, files: mine, ...outcome }))
      return outcome
    } finally {
      await io.removeTree(ownLock)
    }
  }

  const readInfo = async (lock: string): Promise<Info | undefined> => {
    const text = await io.readFile(join(lock, 'info.json'))
    try {
      const info: unknown = text === undefined ? undefined : JSON.parse(text)
      if (!isDict(info)) return undefined
      return {
        started: Number.isFinite(Number(info.started)) ? Number(info.started) : undefined,
        limit: Number(info.timeoutMs) || 0,
        key: typeof info.key === 'string' ? info.key : undefined,
        files: Array.isArray(info.files) ? info.files.map(String) : undefined,
      }
    } catch {
      return undefined // 書きかけは info 無しと同じに扱う
    }
  }

  const remainingMs = async (lock: string, info: Info | undefined): Promise<number> => {
    const started = info?.started ?? (await io.stat(lock))?.mtimeMs ?? (await io.now())
    return started + (info?.limit ?? 0) + GRACE_MS - (await io.now())
  }

  const covers = (theirs: readonly string[] | undefined): boolean => theirs !== undefined && mine.every((f) => theirs.includes(f))

  /**
   * 同じキーで実行中の、自分のファイル一覧を含むロックを探す。期限切れのロックはここで片付ける。info.json がまだ無い
   * ロック（実行側が mkdir してから書くまでの隙間）は、どの一覧か判定できないので pending として返す。
   */
  const findRunning = async (): Promise<{ lock?: string; pending: boolean }> => {
    let pending = false
    for (const e of await io.list(dir)) {
      if (e.kind !== 'dir' || !e.name.startsWith(keyPrefix) || !e.name.endsWith('.run')) continue
      const lock = join(dir, e.name)
      const info = await readInfo(lock)
      const alive = (await remainingMs(lock, info)) > 0
      if (!info) {
        if (alive) pending = true
        continue
      }
      if (info.key !== key || !covers(info.files)) continue
      if (!alive) {
        await io.removeTree(lock)
        continue
      }
      return { lock, pending }
    }
    return { pending }
  }

  const readOutcome = async (resultFile: string): Promise<SharedOutcome | undefined> => {
    const text = await io.readFile(resultFile)
    if (text === undefined) return undefined
    try {
      const r: unknown = JSON.parse(text)
      if (!isDict(r) || r.key !== key || !Array.isArray(r.files) || !covers(r.files.map(String))) return undefined
      return { out: String(r.out ?? ''), ok: r.ok === true, timedOut: r.timedOut === true, logpath: String(r.logpath ?? '') }
    } catch {
      return undefined
    }
  }

  let announced = false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const found = await findRunning()
    if (!found.lock && found.pending) {
      // info が現れるのを待って探し直す。猶予を過ぎれば pending でなくなるので、ラウンドは消費しない
      await io.run(['sleep', POLL_SECONDS])
      round--
      continue
    }
    let target = found.lock
    if (!target) {
      if (await claim()) return { outcome: await lead(), shared: false }
      target = ownLock // 同じ一覧の実行が info を書く前だった場合など。そのロックを待つ
    }
    const left = await remainingMs(target, await readInfo(target))
    if (left <= 0) {
      await io.removeTree(target)
      continue
    }
    if (!announced) {
      announced = true
      await hooks.onWait?.()
    }
    await io.run(['sh', '-c', `while [ -d "$1" ]; do sleep ${POLL_SECONDS}; done`, 'sh', target], { timeoutMs: Math.min(Math.max(left, 1), MAX_WAIT_MS) })
    if (await io.exists(target)) continue
    const outcome = await readOutcome(resultOf(target))
    if (outcome) return { outcome, shared: true }
  }
  return { outcome: await execute(), shared: false }
}
