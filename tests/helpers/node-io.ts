// テスト用: Node の fs / child_process で Io を実装する。
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DirEntry, EnvVars, Io, RunOptions, RunResult, Stat } from '../../src/io.ts'
import { mergeRunning, runningBand, runningLines } from '../../src/running-registry.ts'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 既定ポリシーは policy: を書かなくても適用されるので、DOGWOOD_BIN を差さないと PATH や ~/.cargo/bin の実バイナリを
// 拾ってしまう。既定で存在しないパスを差して「dogwood 未導入」を作り、偽バイナリを明示したテストだけが判定経路に
// 乗るようにする。
export const MISSING_DOGWOOD_BIN = path.join(REPO_ROOT, 'tests', 'no-such-dogwood')

export type NodeIoOptions = {
  projectDir: string
  cwd?: string
  pluginRoot?: string
  env?: EnvVars
  /** 現在時刻（ミリ秒）を差し替える。 */
  now?: () => number
  /** progress() に渡されたテキストを順に記録する。 */
  progressLog?: Array<string | undefined>
  /** result() に渡されたテキストを順に記録する。 */
  resultLog?: Array<string | undefined>
  /** redraw() のたびに、その時点で帯に描かれる内容（行を改行でつないだもの。帯が出ないなら undefined）を記録する。 */
  bandLog?: Array<string | undefined>
  /** every() を差し替える（時間を注入するため）。省略時は setInterval。 */
  every?: (ms: number, fn: () => void) => () => void
}

/** 共有の実行中一覧のファイルを同期で読み、帯に描かれる内容を返す（redraw の時点の記録用）。 */
function snapshotBand(projectDir: string, now: number): string | undefined {
  const dir = path.join(projectDir, '.claude', '.gate-status', 'running')
  const texts = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : []
  const entries = mergeRunning(texts, now)
  return runningBand(entries, now) ? runningLines(entries, now).join('\n') : undefined
}

const kindOf = (s: fs.Stats): 'file' | 'dir' | 'other' => (s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other')

export function makeIo(opts: NodeIoOptions): Io {
  const env: EnvVars = { HOME: process.env.HOME, PATH: process.env.PATH, DOGWOOD_BIN: MISSING_DOGWOOD_BIN, ...opts.env }
  const stat = async (p: string): Promise<Stat | undefined> => {
    try {
      const s = fs.statSync(p)
      return { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  }
  return {
    env,
    projectDir: opts.projectDir,
    cwd: opts.cwd ?? opts.projectDir,
    pluginRoot: opts.pluginRoot ?? REPO_ROOT,
    readFile: async (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    writeFile: async (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, text)
    },
    exists: async (p) => fs.existsSync(p),
    stat,
    list: async (p): Promise<DirEntry[]> => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((d) => {
          const full = path.join(p, d.name)
          const s = fs.lstatSync(full)
          return { name: d.name, kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', mtimeMs: s.isFile() ? s.mtimeMs : 0 }
        })
      } catch {
        return []
      }
    },
    isExecutable: async (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    },
    removeFiles: async (paths) => {
      for (const p of paths) fs.rmSync(p, { force: true })
    },
    removeDir: async (p) => {
      try {
        fs.rmdirSync(p)
      } catch {
        // 空でない・無い場合は何もしない
      }
    },
    removeTree: async (p) => {
      fs.rmSync(p, { recursive: true, force: true })
    },
    run: (argv, options) => runProcess(argv, options),
    now: async () => (opts.now ? opts.now() : Date.now()),
    progress: (text) => {
      opts.progressLog?.push(text)
    },
    result: (text) => {
      opts.resultLog?.push(text)
    },
    redraw: () => {
      opts.bandLog?.push(snapshotBand(opts.projectDir, opts.now ? opts.now() : Date.now()))
    },
    every:
      opts.every ??
      ((ms, fn) => {
        const t = setInterval(fn, ms)
        return () => clearInterval(t)
      }),
  }
}

function runProcess(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    if (!cmd) return resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false, error: 'empty argv' })
    let child: ReturnType<typeof spawn>
    try {
      // サブエージェント経由で起動された場合に親の CLAUDE_AGENT_ID が漏れ込むと、agent_id 無しのテストが環境依存になる。
      const { CLAUDE_AGENT_ID: _inherited, ...inheritedEnv } = process.env
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: { ...inheritedEnv, ...options.env },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false, error: String(e) })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, options.timeoutMs ?? 30_000)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => finish({ exitCode: 1, stdout, stderr, timedOut, error: e.message }))
    child.on('close', (code) => finish({ exitCode: timedOut ? 1 : (code ?? 1), stdout, stderr, timedOut }))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin ?? '')
  })
}

/** 一時ディレクトリを作る（realpath 済み）。 */
export function tmpDir(prefix = 'gate-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** テスト用の一時ディレクトリを作り、body の後に必ず消す。 */
export async function withTmp<T>(body: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = tmpDir()
  try {
    return await body(dir)
  } finally {
    rmTree(dir)
  }
}
