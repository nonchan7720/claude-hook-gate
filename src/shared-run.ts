// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// .gate-status/shared/ 配下のファイルで調停する:
//   - <hash>.run/   ロックディレクトリ。`mkdir` は原子的なので、作れた側が実行側（先着 1 名）になる。
//                   中の info.json に開始時刻とタイムアウトを書く。
//   - <hash>.result.json  実行側が完了時、ロックを外す前に書く結果。
// 後から来た側は新たに起動せず、ロックが消えるまで待って結果を受け取る。完了済みの結果は再利用しない
// （次に同じキーが来たら実行し直す）。ロックは「開始時刻 + タイムアウト + 猶予」を過ぎたら実行側が
// 落ちたとみなして奪い直す。
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

/** key の実行を共有する。戻り値の shared は「他の側の結果を受け取った」こと。 */
export async function runShared(
  io: Io,
  key: string,
  timeoutMs: number,
  execute: () => Promise<SharedOutcome>,
  hooks: Hooks = {},
): Promise<{ outcome: SharedOutcome; shared: boolean }> {
  const dir = join(gateStatusDir(io), 'shared')
  const base = join(dir, hashKey(key))
  const lock = `${base}.run`
  const resultFile = `${base}.result.json`

  const claim = async (): Promise<boolean> => (await io.run(['sh', '-c', 'mkdir -p "$1" && mkdir "$2"', 'sh', dir, lock])).exitCode === 0

  const lead = async (): Promise<SharedOutcome> => {
    await io.writeFile(join(lock, 'info.json'), JSON.stringify({ started: await io.now(), timeoutMs }))
    await io.removeFiles([resultFile])
    try {
      const outcome = await execute()
      await io.writeFile(resultFile, JSON.stringify({ key, ...outcome }))
      return outcome
    } finally {
      await io.removeTree(lock)
    }
  }

  const remainingMs = async (): Promise<number> => {
    const text = await io.readFile(join(lock, 'info.json'))
    let started: number | undefined
    let limit = 0
    try {
      const info: unknown = text === undefined ? undefined : JSON.parse(text)
      if (isDict(info)) {
        started = Number(info.started)
        limit = Number(info.timeoutMs) || 0
      }
    } catch {
      // 書きかけは info 無しと同じに扱う
    }
    started ??= (await io.stat(lock))?.mtimeMs ?? (await io.now())
    return started + limit + GRACE_MS - (await io.now())
  }

  const readOutcome = async (): Promise<SharedOutcome | undefined> => {
    const text = await io.readFile(resultFile)
    if (text === undefined) return undefined
    try {
      const r: unknown = JSON.parse(text)
      if (!isDict(r) || r.key !== key) return undefined
      return { out: String(r.out ?? ''), ok: r.ok === true, timedOut: r.timedOut === true, logpath: String(r.logpath ?? '') }
    } catch {
      return undefined
    }
  }

  let announced = false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (await claim()) return { outcome: await lead(), shared: false }
    const left = await remainingMs()
    if (left <= 0) {
      await io.removeTree(lock)
      continue
    }
    if (!announced) {
      announced = true
      await hooks.onWait?.()
    }
    await io.run(['sh', '-c', `while [ -d "$1" ]; do sleep ${POLL_SECONDS}; done`, 'sh', lock], { timeoutMs: Math.min(left, MAX_WAIT_MS) })
    if (await io.exists(lock)) continue
    const outcome = await readOutcome()
    if (outcome) return { outcome, shared: true }
  }
  return { outcome: await execute(), shared: false }
}
