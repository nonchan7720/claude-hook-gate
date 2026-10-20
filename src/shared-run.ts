// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// 共有ディレクトリ（下記 sharedDir）配下のファイルで調停する:
//   - <キーのハッシュ>.<ファイル一覧のハッシュ>.run/   ロックディレクトリ。`mkdir` は原子的なので、作れた側が
//                   実行側（先着 1 名）になる。中の info.json にキー・ファイル一覧・開始時刻・タイムアウトを書く。
//   - <同じ名前>.result.json  実行側が完了時、ロックを外す前に書く結果（キーとファイル一覧付き）。
// 共有の単位はキー（root・cwd・cmd など）で、各実行は対象ファイル一覧を別に持つ。同じキーのロックが複数並び得る。
// 後から来た側は、同じキーで実行中のロックのうち実行側のファイル一覧が自分の一覧を含むもの（空の一覧はどれにも
// 含まれる）があれば、新たに起動せずロックが消えるまで待って結果を受け取る。無ければ自分で実行する。
// 完了済みの結果は再利用しない（次に同じキーが来たら実行し直す）。ロックは「開始時刻 + タイムアウト + 猶予」を
// 過ぎたら実行側が落ちたとみなして奪い直す。
//
// 加えて、直列化の単位（serial。gate では name、無ければ cmd）ごとに 1 本しか走らせない:
//   - <serial のハッシュ>.serial/   実行側が実行の間だけ持つ排他ロック（中に info.json）。
//
// ロックの生死はコマンドのプロセスで判定する。実行側はコマンドを走らせるシェルの PID を両方のロックの pid に書き、
// 待つ側は kill -0 で生きているかを見る。ESC などで hook が止められてロックが外れなくても、コマンドが終わって
// いれば次の側がすぐ奪い直せる（コマンドが走り続けているなら CPU を使っているので、終わるまで待つ）。PID が
// 書かれる前（info から GRACE_MS 以内）は生きているとみなし、それを過ぎても PID が無いロックは死んでいるとみなす。
// コマンドが終わってから実行側が結果を書いてロックを外すまでにも隙間があるので、PID が死んでいてもすぐには奪わず、
// DEAD_GRACE_MS だけロックが消えるのを待つ（消えたら正常に終わった実行として扱い、結果を受け取る）。
// 結果を受け取れない（ファイル一覧を含まない・環境変数が違う）同じコマンドが走っているときも、並行して起動せず、
// それが終わるのを待ってから、改めて受け取れる実行を探すか自分で実行する。重いコマンド（go test ./... など）を
// エージェントの数だけ同時に走らせないため。
//
// これらのファイルは同じリポジトリのすべての git worktree で共通の場所（~/.claude/.gate-status/shared/<project_id>/。
// sharedDir）に置く。サブエージェントが別の worktree で動いても、直列化（serial）は worktree をまたいで効く。
// キーには root・cwd が入るので、worktree が違えば結果は共有されない（別のコードを見ているため）。
import type { Io } from './io.ts'
import { basename, dirname, isAbsolute, join, normpath } from './path.ts'
import { isDict } from './pyutil.ts'
import { gateStatusDir } from './running-registry.ts'

export type SharedOutcome = { out: string; ok: boolean; timedOut: boolean; logpath: string }

const GRACE_MS = 5000 // 実行側が info.json を書くまでの隙間と、タイムアウト処理の余裕
const MAX_WAIT_MS = 600_000 // 1 回の待機の上限（$.process.run の上限）
const MAX_ROUNDS = 20 // 実行側の失敗が続いても待ち続けない。超えたら共有せず自分で実行する
const POLL_SECONDS = '0.05'
const DEAD_GRACE_MS = 1500 // コマンドの終了から、実行側が結果を書いてロックを外すまでの猶予

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

const sharedDirCache = new Map<string, Promise<string>>()

/**
 * 共有・直列化のロックと結果の置き場所: ~/.claude/.gate-status/shared/<project_id>/。project_id は
 * `git rev-parse --git-common-dir` の絶対パス（同じリポジトリならどの worktree からでも同じ）から作る
 * `<名前>-<ハッシュ>`。git でない・失敗したときは projectDir の絶対パスから作る。HOME が無ければ従来どおり
 * gateStatusDir(io)/shared。git の呼び出しを毎回しないよう、プロセス内でキャッシュする。
 */
export function sharedDir(io: Io): Promise<string> {
  const base = io.projectDir || io.cwd
  const home = io.env.HOME
  const cacheKey = JSON.stringify([home, base])
  let cached = sharedDirCache.get(cacheKey)
  if (!cached) {
    cached = (async () => {
      if (!home) return join(gateStatusDir(io), 'shared')
      const ask = async (args: string[]): Promise<string | undefined> => {
        try {
          const r = await io.run(['git', '-C', base, 'rev-parse', ...args, '--git-common-dir'], { timeoutMs: 10_000 })
          const out = r.stdout.trim()
          return r.exitCode === 0 && out && !out.includes('\n') ? out : undefined
        } catch {
          return undefined
        }
      }
      // 古い git は --path-format を知らない。そのときは相対パスを projectDir 基準で解決する
      const common = (await ask(['--path-format=absolute'])) ?? (await ask([]))
      const anchor = common ? normpath(isAbsolute(common) ? common : join(base, common)) : normpath(base)
      const label = (common && basename(anchor) === '.git' ? basename(dirname(anchor)) : basename(anchor)).replace(/[^A-Za-z0-9._-]/g, '_') || 'project'
      return join(io.homeConfigDir, '.gate-status', 'shared', `${label}-${hashKey(anchor)}`)
    })()
    sharedDirCache.set(cacheKey, cached)
  }
  return cached
}

/** serial: 直列化の単位（省略時は key）。onWait: 待機側になったとき（最初の 1 回）に呼ばれる。 */
type Hooks = { onWait?: () => void | Promise<void>; serial?: string }

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
  execute: (pidFiles: string[]) => Promise<SharedOutcome>,
  hooks: Hooks = {},
): Promise<{ outcome: SharedOutcome; shared: boolean }> {
  const mine = normalizeFiles(files)
  const dir = await sharedDir(io)
  const keyPrefix = `${hashKey(key)}.`
  const ownLock = join(dir, `${shareId(key, mine)}.run`)
  const resultOf = (lock: string): string => `${lock.slice(0, -'.run'.length)}.result.json`

  const serialLock = join(dir, `${hashKey(hooks.serial ?? key)}.serial`)

  const mkdirAtomic = async (path: string): Promise<boolean> => (await io.run(['sh', '-c', 'mkdir -p "$1" && mkdir "$2"', 'sh', dir, path])).exitCode === 0
  const claim = (): Promise<boolean> => mkdirAtomic(ownLock)

  /** 排他ロックを持った状態で実行し、結果を書いてから両方のロックを外す。 */
  const lead = async (): Promise<SharedOutcome> => {
    const resultFile = resultOf(ownLock)
    try {
      const started = await io.now()
      // 実行のロックの info を先に書く。排他ロックの info が見えた時点で、待つ側が受け取れる実行かを判定できるように。
      await io.writeFile(join(ownLock, 'info.json'), JSON.stringify({ started, timeoutMs, key, files: mine }))
      await io.writeFile(join(serialLock, 'info.json'), JSON.stringify({ started, timeoutMs }))
      await io.removeFiles([resultFile])
      try {
        const outcome = await execute([join(serialLock, 'pid'), join(ownLock, 'pid')])
        await io.writeFile(resultFile, JSON.stringify({ key, files: mine, ...outcome }))
        return outcome
      } finally {
        await io.removeTree(ownLock)
      }
    } finally {
      await io.removeTree(serialLock)
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

  /** ロックが生きている残り時間。期限切れ、またはコマンドのプロセスが終わっていれば 0 以下。 */
  const remainingMs = async (lock: string, info: Info | undefined): Promise<number> => {
    const now = await io.now()
    const started = info?.started ?? (await io.stat(lock))?.mtimeMs ?? now
    const left = started + (info?.limit ?? 0) + GRACE_MS - now
    if (left <= 0) return left
    const pid = (await io.readFile(join(lock, 'pid')))?.trim()
    if (pid) {
      if (/^\d+$/.test(pid) && (await io.run(['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', pid])).exitCode === 0) return left
      // コマンドは終わっている。実行側が結果を書いてロックを外す途中かもしれないので、少しの間ロックが消えるのを待つ。
      // 消えたら生きている扱いで返す（呼び出し側は待機に入り、消えているのですぐ抜けて結果を読む）。消えなければ死亡。
      const polls = Math.ceil(DEAD_GRACE_MS / (Number(POLL_SECONDS) * 1000))
      const script = `i=0; while [ -d "$1" ] && [ "$i" -lt ${polls} ]; do sleep ${POLL_SECONDS}; i=$((i+1)); done; [ ! -d "$1" ]`
      return (await io.run(['sh', '-c', script, 'sh', lock])).exitCode === 0 ? GRACE_MS : 0
    }
    // PID がまだ無い。info があるのに GRACE_MS を過ぎても書かれないなら、コマンドを起動する前に止められている。
    return info && now - started > GRACE_MS ? 0 : left
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
  const announce = async (): Promise<void> => {
    if (announced) return
    announced = true
    await hooks.onWait?.()
  }
  /** ロックが消えるか、そのコマンドのプロセスが終わるまで待つ。終わっていたら、呼び出し側が次のラウンドで奪い直す。 */
  const waitGone = async (path: string, left: number): Promise<void> => {
    const script = `while [ -d "$1" ]; do if [ -s "$1/pid" ] && ! kill -0 "$(cat "$1/pid")" 2>/dev/null; then exit 3; fi; sleep ${POLL_SECONDS}; done`
    await io.run(['sh', '-c', script, 'sh', path], { timeoutMs: Math.min(Math.max(left, 1), MAX_WAIT_MS) })
  }

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
      // 受け取れる実行が無い。同じ直列化の単位の実行が走っていれば、終わるまで待ってから探し直す。
      if (!(await mkdirAtomic(serialLock))) {
        const info = await readInfo(serialLock)
        const left = await remainingMs(serialLock, info)
        if (left <= 0) {
          await io.removeTree(serialLock)
          continue
        }
        if (!info) {
          // ロックが無いのに作れない（.gate-status に書けないなど）。ラウンドを消費して、尽きたら共有せず自分で実行する
          if (!(await io.exists(serialLock))) continue
          // 実行側が排他ロックを取ってから info を書くまでの隙間。書かれるのを待って探し直す（ラウンドは消費しない）
          await io.run(['sleep', POLL_SECONDS])
          round--
          continue
        }
        // info があれば実行のロックの info も書かれている。受け取れる実行なら、それを待つ。
        const again = await findRunning()
        if (!again.lock) {
          await announce()
          await waitGone(serialLock, left)
          continue
        }
        target = again.lock
      } else if (await claim()) {
        return { outcome: await lead(), shared: false }
      } else {
        await io.removeTree(serialLock)
        target = ownLock // 同じ一覧の実行が info を書く前だった場合など。そのロックを待つ
      }
    }
    const left = await remainingMs(target, await readInfo(target))
    if (left <= 0) {
      await io.removeTree(target)
      continue
    }
    await announce()
    await waitGone(target, left)
    if (await io.exists(target)) continue
    const outcome = await readOutcome(resultOf(target))
    if (outcome) return { outcome, shared: true }
  }
  return { outcome: await execute([]), shared: false }
}
