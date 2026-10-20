// settings hook の CLI（src/cli.ts）用: Node の fs / child_process で Io を実装する。
// mod の実行環境（engine-io.ts）と違って普通の Node プロセスなので、ファイルとプロセスにはそのまま触れる。
// 画面に出す手段（progress / result / redraw / every）は持たない（no-op）。プロンプト上の帯は mod 側の ui.render が
// 実行中一覧のファイル（<設定ディレクトリ>/.gate-status/running/）を読んで描くので、一覧ファイルの読み書きは従来どおり行う。
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_CONFIG_DIRS } from './config-dir.ts'
import { resolveLang } from './i18n.ts'
import type { DirEntry, EnvVars, Io, RunOptions, RunResult, Stat } from './io.ts'

const kindOf = (s: fs.Stats): 'file' | 'dir' | 'other' => (s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other')

/** process.env から、Io の EnvVars が使うものだけを拾う。 */
export function pickEnv(env: NodeJS.ProcessEnv): EnvVars {
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    CLAUDE_FEEDBACK_DIR: env.CLAUDE_FEEDBACK_DIR,
    DOGWOOD_BIN: env.DOGWOOD_BIN,
    TERM_PROGRAM: env.TERM_PROGRAM,
    __CFBundleIdentifier: env.__CFBundleIdentifier,
    FEEDBACK_GATE_LANG: env.FEEDBACK_GATE_LANG,
    LC_ALL: env.LC_ALL,
    LC_MESSAGES: env.LC_MESSAGES,
    LANG: env.LANG,
  }
}

export type NodeIoInit = {
  env: NodeJS.ProcessEnv
  /** stdin JSON の cwd（CLAUDE_PROJECT_DIR が無いときの projectDir の代わり）。 */
  payloadCwd?: string
  /** プラグイン設定 language（CLAUDE_PLUGIN_OPTION_language）。 */
  language?: string
  autoCount?: boolean
  /** 通知の見出しに使うアプリ名（Io.appName）。 */
  appName?: string
  /** 設定ディレクトリ名の候補（Io.configDirNames）。省略時は Claude Code のもの。 */
  configDirNames?: readonly string[]
}

/** 候補のうち最初に存在するディレクトリ。無ければ先頭。 */
export function pickConfigDirSync(names: readonly string[], base: string): string {
  for (const name of names) if (fs.existsSync(join(base, name))) return join(base, name)
  return join(base, names[0] ?? '.claude')
}

export function makeNodeIo(init: NodeIoInit): Io {
  const env = pickEnv(init.env)
  const cwd = init.payloadCwd || process.cwd()
  const projectDir = init.env.CLAUDE_PROJECT_DIR || cwd
  const configDirNames = init.configDirNames ?? CLAUDE_CONFIG_DIRS
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
    lang: resolveLang(env, init.language),
    ...(init.autoCount !== undefined ? { autoCount: init.autoCount } : {}),
    projectDir,
    cwd,
    pluginRoot: init.env.CLAUDE_PLUGIN_ROOT || process.cwd(),
    configDirNames,
    projectConfigDir: pickConfigDirSync(configDirNames, projectDir),
    homeConfigDir: pickConfigDirSync(configDirNames, env.HOME || '~'),
    ...(init.appName !== undefined ? { appName: init.appName } : {}),
    readFile: async (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    writeFile: async (p, text) => {
      fs.mkdirSync(dirname(p), { recursive: true })
      fs.writeFileSync(p, text)
    },
    exists: async (p) => fs.existsSync(p),
    stat,
    list: async (p): Promise<DirEntry[]> => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((d) => {
          const s = fs.lstatSync(join(p, d.name))
          return { name: d.name, kind: kindOf(s), mtimeMs: s.isFile() ? s.mtimeMs : 0 }
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
    now: async () => Date.now(),
    progress: () => undefined,
    result: () => undefined,
    redraw: () => undefined,
    every: () => () => undefined,
  }
}

function runProcess(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    if (!cmd) return resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false, error: 'empty argv' })
    let child: ReturnType<typeof spawn>
    try {
      // サブエージェント経由で起動された場合に親の CLAUDE_AGENT_ID が漏れ込むと、agent_id の判定が環境依存になる。
      const { CLAUDE_AGENT_ID: _inherited, ...inheritedEnv } = process.env
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: { ...inheritedEnv, ...options.env },
        // タイムアウトで子孫ごと止められるよう、独立したプロセスグループにする。
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
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    // timeoutMs の指定があるときだけ打ち切る（指定が無ければ、hooks.json の timeout が上限になる）。
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            try {
              if (child.pid) process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }, options.timeoutMs)
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
