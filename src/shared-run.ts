// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// 共有ディレクトリ（下記 sharedDir）配下のファイルで調停する:
//   - <キーのハッシュ>.<ファイル一覧のハッシュ>.run/   ロックディレクトリ。`mkdir` して中に .owner を作れた側（mkdirAtomicIn）が
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
// 待つ側が多いときに順に 1 本ずつ走らせないよう、待っている側の対象ファイル一覧はまとめる（batching）:
//   - <serial のハッシュ>.queue/<ShareID>.json   待つ側が置くキーと対象ファイル一覧。次に実行側になった者が同じキーの分を
//     自分の一覧に足して（和集合で）走らせ、置かれた分を消す。待っていた側はその実行に含まれるので結果を受け取る。
//
// さらに、違うコマンドの同時実行数にも上限を置く（max_parallel。gate.yaml のトップレベル、既定 2）:
//   - slot.<i>/   同時実行枠（i は 0 から枠数 - 1）。実行側になる者（と共有しない実行）は枠を 1 つ取ってから走らせ、
//     終わったら消す。中の info.json と pid でロックと同じように生死を判定する。受け取るだけなら枠は要らない。
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

/**
 * serial: 直列化の単位（省略時は key）。onWait: 待機側になったとき（最初の 1 回）に呼ばれる。
 * maxParallel: 同時実行枠の数（0 以下・省略は無制限）。実行側になるとき（と共有しない実行）はこの枠を 1 つ取ってから走らせる。
 */
type Hooks = { onWait?: () => void | Promise<void>; serial?: string; maxParallel?: number }

/**
 * 実行側になったときに呼ばれる。pidFiles はロックの pid ファイル（コマンドを走らせるシェルの PID を書かせる）、
 * files はこの実行が対象にするファイル一覧（待っている側の分をまとめた和集合。対象ファイルを使わない実行では空）。
 */
export type SharedExecute = (pidFiles: string[], files: string[]) => Promise<SharedOutcome>

const REQUEST_STALE_MS = MAX_WAIT_MS + GRACE_MS // これより古い置き分は、落ちた待ち側の残骸とみなす
const SLOT_WAIT_MS = 5000 // 枠が空くのを 1 回に待つ長さ。超えたら死んだ枠を片付けてから待ち直す

/**
 * path を作れた側（ロックの持ち主）にだけ true。
 *
 * mkdir(1) が原子的でない実装（Ubuntu 26.04 の coreutils は uutils で、存在を確かめてから作るので、同時に呼ぶと複数が
 * 0 で終わる。uutils/coreutils#13970）でも持ち主が 1 人に決まるよう、作った直後に noclobber（set -C。O_EXCL）で
 * .owner を作れた側だけを持ち主とする。シェルの組み込みなので coreutils に依らない。負けた側は mkdir が「成功」して
 * いてもディレクトリは持ち主のものなので、普通に「既にある」のと同じ扱い（false）になる。
 */
const mkdirAtomicIn = async (io: Io, dir: string, path: string): Promise<boolean> =>
  (await io.run(['sh', '-c', 'mkdir -p "$1" && mkdir "$2" && (set -C && : > "$2/.owner") 2>/dev/null', 'sh', dir, path])).exitCode === 0

type Info = { started?: number; limit: number; key?: string; files?: string[] }

const readInfoOf = async (io: Io, lock: string): Promise<Info | undefined> => {
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
const remainingMsOf = async (io: Io, lock: string, info: Info | undefined): Promise<number> => {
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

// ---- 同時実行枠（max_parallel） ----
//
// <共有ディレクトリ>/slot.<i>/（i は 0 から枠数 - 1）を mkdir で取り合う。実行側になる者（と共有しない実行）は
// 枠を 1 つ取ってから走らせ、終わったら消す。中の info.json と pid でロックと同じように生死を判定する。
// 重いコマンドをエージェントの数だけ同時に走らせると CPU の取り合いで全員が何倍も遅くなるので、
// 直列化（同じコマンドは 1 本）に加えて、違うコマンドの同時実行数にも上限を置く。

const slotPath = (dir: string, i: number): string => join(dir, `slot.${i}`)

/** 空いている枠を 1 つ取る。死んだ枠は片付けて取り直す。取れなければ undefined。枠数が 0 以下（無制限）なら { slot: undefined, ok: true }。 */
async function takeSlot(io: Io, dir: string, maxParallel: number, timeoutMs: number): Promise<{ slot?: string; ok: boolean }> {
  if (maxParallel <= 0) return { ok: true }
  const claimSlot = async (slot: string): Promise<boolean> => {
    if (!(await mkdirAtomicIn(io, dir, slot))) return false
    await io.writeFile(join(slot, 'info.json'), JSON.stringify({ started: await io.now(), timeoutMs }))
    return true
  }
  for (let i = 0; i < maxParallel; i++) {
    const slot = slotPath(dir, i)
    if (await claimSlot(slot)) return { slot, ok: true }
    if (!(await io.exists(slot))) return { ok: true } // 枠を作れない（共有ディレクトリに書けないなど）。上限なしで走らせる
    if ((await remainingMsOf(io, slot, await readInfoOf(io, slot))) <= 0) {
      await io.removeTree(slot)
      if (await claimSlot(slot)) return { slot, ok: true }
    }
  }
  return { ok: false }
}

const releaseSlot = async (io: Io, slot: string | undefined): Promise<void> => {
  if (slot) await io.removeTree(slot)
}

/** どれかの枠が空くまで（最長 SLOT_WAIT_MS）待つ。 */
async function waitSlot(io: Io, dir: string, maxParallel: number): Promise<void> {
  const checks = Array.from({ length: maxParallel }, (_, i) => `[ -d "$1/slot.${i}" ]`)
  await io.run(['sh', '-c', `while ${checks.join(' && ')}; do sleep ${POLL_SECONDS}; done`, 'sh', dir], { timeoutMs: SLOT_WAIT_MS })
}

/** 共有も直列化もしない実行を、同時実行枠だけ取って走らせる（share: false 用）。 */
export async function runWithSlot(
  io: Io,
  maxParallel: number,
  timeoutMs: number,
  execute: (pidFiles: string[]) => Promise<SharedOutcome>,
): Promise<SharedOutcome> {
  if (maxParallel <= 0) return execute([])
  const dir = await sharedDir(io)
  for (;;) {
    const { slot, ok } = await takeSlot(io, dir, maxParallel, timeoutMs)
    if (ok) {
      try {
        return await execute(slot ? [join(slot, 'pid')] : [])
      } finally {
        await releaseSlot(io, slot)
      }
    }
    await waitSlot(io, dir, maxParallel)
  }
}

/** ファイル一覧を昇順・重複なしにそろえる。 */
const normalizeFiles = (files: readonly string[]): string[] => [...new Set(files)].sort()

/** ロック・結果ファイルの名前の元になる、キーとファイル一覧の組のハッシュ。 */
export const shareId = (key: string, files: readonly string[]): string => `${hashKey(key)}.${hashKey(JSON.stringify(normalizeFiles(files)))}`

/** key の実行を共有する。files はこの実行が対象にするファイル一覧。戻り値の shared は「他の側の結果を受け取った」こと。 */
export async function runShared(
  io: Io,
  key: string,
  files: readonly string[],
  timeoutMs: number,
  execute: SharedExecute,
  hooks: Hooks = {},
): Promise<{ outcome: SharedOutcome; shared: boolean }> {
  let mine = normalizeFiles(files)
  const dir = await sharedDir(io)
  const keyPrefix = `${hashKey(key)}.`
  let ownLock = join(dir, `${shareId(key, mine)}.run`)
  const resultOf = (lock: string): string => `${lock.slice(0, -'.run'.length)}.result.json`
  const maxParallel = hooks.maxParallel ?? 0

  const serialLock = join(dir, `${hashKey(hooks.serial ?? key)}.serial`)
  // 待っている側が対象ファイル一覧を置く場所と、その中の自分の分（出していなければ undefined）。
  const queueDir = join(dir, `${hashKey(hooks.serial ?? key)}.queue`)
  let request: string | undefined

  const mkdirAtomic = (path: string): Promise<boolean> => mkdirAtomicIn(io, dir, path)
  const claim = (): Promise<boolean> => mkdirAtomic(ownLock)

  /** 排他ロック（と同時実行枠）を持った状態で実行し、結果を書いてから全部のロックを外す。 */
  const lead = async (slot: string | undefined): Promise<SharedOutcome> => {
    const resultFile = resultOf(ownLock)
    try {
      const started = await io.now()
      // 実行のロックの info を先に書く。排他ロックの info が見えた時点で、待つ側が受け取れる実行かを判定できるように。
      await io.writeFile(join(ownLock, 'info.json'), JSON.stringify({ started, timeoutMs, key, files: mine }))
      await io.writeFile(join(serialLock, 'info.json'), JSON.stringify({ started, timeoutMs }))
      await io.removeFiles([resultFile])
      try {
        const pidFiles = [join(serialLock, 'pid'), join(ownLock, 'pid'), ...(slot ? [join(slot, 'pid')] : [])]
        const outcome = await execute(pidFiles, mine)
        await io.writeFile(resultFile, JSON.stringify({ key, files: mine, ...outcome }))
        return outcome
      } finally {
        await io.removeTree(ownLock)
      }
    } finally {
      await io.removeTree(serialLock)
      await releaseSlot(io, slot)
    }
  }

  const readInfo = (lock: string): Promise<Info | undefined> => readInfoOf(io, lock)
  const remainingMs = (lock: string, info: Info | undefined): Promise<number> => remainingMsOf(io, lock, info)

  // ---- 待っている側の対象ファイルをまとめる（batching） ----
  //
  // 受け取れない（対象ファイルを含まない）同じ直列化の単位の実行を待つ側は、自分のキーと対象ファイル一覧を
  // <serial のハッシュ>.queue/<shareId>.json に置く。次に実行側になった者は、同じキーの分を自分の一覧に足して
  // （和集合で）走らせ、置かれた分を消す。待っていた側は、その実行が自分の一覧を含むので受け取れる。
  // 同じコマンドをエージェントの数だけ順に走らせる代わりに、溜まった分を 1 回で済ませるため。
  // 置いた分は runShared を抜けるときに自分で消す（実行側に消されていればそれでよい）。

  /** 自分の対象ファイル一覧を queue に置く（1 回だけ。一覧が空なら置かない: 空の一覧は何にでも含まれる）。 */
  const postRequest = async (): Promise<void> => {
    if (request !== undefined || mine.length === 0) return
    request = join(queueDir, `${shareId(key, mine)}.json`)
    await io.writeFile(request, JSON.stringify({ started: await io.now(), key, files: mine }))
  }
  const withdrawRequest = async (): Promise<void> => {
    if (request === undefined) return
    await io.removeFiles([request])
    request = undefined
  }
  /**
   * queue に置かれた同じキーの一覧を自分の一覧に足し、置かれた分を消す。排他ロックを取った直後、実行のロックを作る前に
   * 呼ぶ（一覧が変わると実行のロックの名前も変わる）。自分の一覧が空なら何もしない。
   */
  const absorbRequests = async (): Promise<void> => {
    if (mine.length === 0) return
    const now = await io.now()
    const union = [...mine]
    const consumed: string[] = []
    for (const e of await io.list(queueDir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
      const path = join(queueDir, e.name)
      const text = await io.readFile(path)
      if (text === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      if (!isDict(parsed)) continue
      const started = Number(parsed.started)
      if (Number.isFinite(started) && started < now - REQUEST_STALE_MS) {
        consumed.push(path)
        continue
      }
      if (parsed.key !== key || !Array.isArray(parsed.files)) continue
      union.push(...parsed.files.map(String))
      consumed.push(path)
    }
    if (consumed.length > 0) await io.removeFiles(consumed)
    mine = normalizeFiles(union)
    ownLock = join(dir, `${shareId(key, mine)}.run`)
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
  /**
   * ロックが消えるか、そのコマンドのプロセスが終わるか、ロックが別の実行のものに替わるまで待つ。終わっていたら、呼び出し側が
   * 次のラウンドで奪い直す。消えてから次の実行側が同じパスで作り直すのがポーリングの間に収まると「消えた」ことを見逃すので、
   * 待ち始めたときの info.json の中身を覚えておき、変わったら起きる（次のラウンドで新しい実行を見に行く）。
   */
  const waitGone = async (path: string, left: number): Promise<void> => {
    const info = (await io.readFile(join(path, 'info.json'))) ?? ''
    const script =
      'while [ -d "$1" ]; do ' +
      'if [ -n "$2" ] && [ "$(cat "$1/info.json" 2>/dev/null)" != "$2" ]; then exit 4; fi; ' +
      `if [ -s "$1/pid" ] && ! kill -0 "$(cat "$1/pid")" 2>/dev/null; then exit 3; fi; sleep ${POLL_SECONDS}; done`
    await io.run(['sh', '-c', script, 'sh', path, info], { timeoutMs: Math.min(Math.max(left, 1), MAX_WAIT_MS) })
  }

  try {
    return await rounds()
  } finally {
    await withdrawRequest()
  }

  async function rounds(): Promise<{ outcome: SharedOutcome; shared: boolean }> {
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
        // 実行側になるには同時実行枠が要る。空いていなければ空くのを待って探し直す（その間に受け取れる実行が
        // 始まっていれば、次のラウンドでそれを待つ）。ラウンドは消費しない。
        const { slot, ok } = await takeSlot(io, dir, maxParallel, timeoutMs)
        if (!ok) {
          await waitSlot(io, dir, maxParallel)
          round--
          continue
        }
        // 受け取れる実行が無い。同じ直列化の単位の実行が走っていれば、終わるまで待ってから探し直す。
        if (!(await mkdirAtomic(serialLock))) {
          await releaseSlot(io, slot)
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
            // 受け取れない実行を待つ。自分の一覧を置いておき、次の実行側にまとめて走らせてもらう。
            await postRequest()
            await announce()
            await waitGone(serialLock, left)
            continue
          }
          target = again.lock
        } else {
          await absorbRequests()
          if (await claim()) return { outcome: await lead(slot), shared: false }
          await releaseSlot(io, slot)
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
    return { outcome: await runWithSlot(io, maxParallel, timeoutMs, (pidFiles) => execute(pidFiles, mine)), shared: false }
  }
}
