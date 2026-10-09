// テスト用の擬似エンジン: register() が登録する hook を保持し、`$`（Engine）を Node の fs / プロセスで実装する。
import * as fs from 'node:fs'
import type { Engine, Hook, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { makeIo, REPO_ROOT } from './node-io.ts'

export type FakeEngineOptions = {
  projectDir: string
  env?: Record<string, string>
  options?: PluginOptions
  sessionId?: string
  /** $.ui.status に渡されたテキストを順に記録する。 */
  statusLog?: Array<string | undefined>
  /** $.ui.invalidate に渡されたイベントを順に記録する。 */
  invalidateLog?: string[]
  /** $.clock.every に渡された間隔(ms)を順に記録する。 */
  timerLog?: number[]
  /** 真を返している間、$.clock.every は登録の時点で指定時間が経過済みとして fn を呼ぶ。 */
  elapsed?: () => boolean
  /** $.process.run に渡された argv を順に記録する。 */
  runLog?: string[][]
  /** argv[0] がこの一覧にあるコマンドは実行せず、記録だけして失敗扱いで返す。 */
  stubCommands?: string[]
  /** $.command.register に渡された引数を順に記録する。 */
  commandLog?: Array<{ name: string; description: string }>
}

export type FakeEngine = {
  $: Engine
  call: (event: string, e: unknown, next?: (e: never) => Promise<unknown>) => Promise<HookResult>
  register: (register: Register) => void
}

export function makeEngine(opts: FakeEngineOptions): FakeEngine {
  const env = { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', ...opts.env } as Record<string, string | undefined>
  const io = makeIo({ projectDir: opts.projectDir })
  const $: Engine = {
    plugin: { root: REPO_ROOT },
    session: { id: async () => opts.sessionId ?? 'sess-1', root: async () => opts.projectDir, cwd: async () => opts.projectDir },
    env: { get: async (name) => env[name] },
    clock: {
      now: async () => Date.now(),
      every: (ms, fn) => {
        opts.timerLog?.push(ms)
        // 時間を注入する: 真を返している間は、登録した時点で既にその時間が経ったものとして fn を呼ぶ。
        if (opts.elapsed?.()) fn()
        return { cancel: () => undefined }
      },
    },
    ui: {
      status: (text) => void opts.statusLog?.push(text),
      invalidate: (event) => void opts.invalidateLog?.push(event),
    },
    fs: {
      read: async (p) => fs.readFileSync(p, 'utf8'),
      write: async (p, text) => {
        fs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
        fs.writeFileSync(p, text)
      },
      list: async (p) =>
        fs.readdirSync(p ?? '.', { withFileTypes: true }).map((d) => {
          const s = fs.lstatSync(`${p}/${d.name}`)
          return {
            name: d.name,
            kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other',
            size: s.size,
            mtimeMs: s.isFile() ? s.mtimeMs : 0,
            isLink: s.isSymbolicLink(),
          }
        }),
      exists: async (p) => fs.existsSync(p),
      stat: async (p) => {
        const s = fs.statSync(p)
        return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: false }
      },
    },
    process: {
      run: async (argv, init) => {
        opts.runLog?.push([...argv])
        if (opts.stubCommands?.includes(argv[0] ?? '')) return { exitCode: 1, stdout: '', stderr: '' }
        const r = await io.run(argv, init)
        if (r.error !== undefined) throw new Error(r.error)
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      },
    },
    command: {
      register: async (command) => {
        opts.commandLog?.push({ name: command.name, description: command.description })
      },
    },
  }
  const hooks = new Map<string, Hook>()
  return {
    $,
    call: async (event, e, next = async () => ({})) => {
      const hook = hooks.get(event)
      if (!hook) throw new Error(`no hook for ${event}`)
      return hook($, e as HookEvent, next as never)
    },
    register: (register) => {
      // `on('ui.render', { component }, hook)` のように matcher を挟む形でも、最後の引数が hook。
      register((event: string, ...args: unknown[]) => hooks.set(event, args.at(-1) as Hook), opts.options ?? {})
    },
  }
}

/** register を読み込んだ擬似エンジンを返す。 */
export function loadMod(register: Register, opts: FakeEngineOptions) {
  const engine = makeEngine(opts)
  engine.register(register)
  return engine
}
