// テスト用の擬似エンジン: register() が登録する hook を保持し、`$`（Engine）を Node の fs / プロセスで実装する。
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { Engine, Hook, HookEvent, HookResult, PluginOptions, ProcessSpawnChunk, ProcessSpawnInit, Register } from 'claude-code'
import { feedbackGateBin } from './go-binary.ts'
import { makeIo, REPO_ROOT, TEST_HOME } from './node-io.ts'

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
  /** $.process.spawn に渡された引数を順に記録する。 */
  spawnLog?: ProcessSpawnInit[]
  /** $.command.register に渡された引数を順に記録する。 */
  commandLog?: Array<{ name: string; description: string }>
}

export type FakeEngine = {
  $: Engine
  call: (event: string, e: unknown, next?: (e: never) => Promise<unknown>) => Promise<HookResult>
  register: (register: Register) => void
}

export function makeEngine(opts: FakeEngineOptions): FakeEngine {
  // 既定の言語は日本語（テストの期待値は日本語で書かれている）。opts.env の LANG / options.language で切り替えられる。
  const env = { HOME: TEST_HOME, PATH: process.env.PATH ?? '', LANG: 'ja_JP.UTF-8', ...opts.env } as Record<string, string | undefined>
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
      // 本物のエンジンと同じく、環境は $.env の値に init.env を重ねたもの。scripts/hook.sh がテスト用にビルドした
      // Go 版のバイナリを使うよう FEEDBACK_GATE_BIN を足す。
      spawn: (init) => {
        opts.spawnLog?.push(init)
        const childEnv: Record<string, string> = { FEEDBACK_GATE_BIN: feedbackGateBin() }
        for (const [k, v] of Object.entries({ ...env, ...init.env })) if (v !== undefined) childEnv[k] = v
        return spawnChunks(init, childEnv)
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
      // command.run はコマンド名ごとに登録される（matcher の command）ので、イベントの command で引く。
      const command = (e as { command?: unknown } | undefined)?.command
      const hook = (typeof command === 'string' ? hooks.get(`${event}:${command}`) : undefined) ?? hooks.get(event)
      if (!hook) throw new Error(`no hook for ${event}`)
      return hook($, e as HookEvent, next as never)
    },
    register: (register) => {
      // `on('ui.render', { component }, hook)` のように matcher を挟む形でも、最後の引数が hook。
      // matcher に command があれば（command.run）、コマンド名ごとに分けて控える。
      register((event: string, ...args: unknown[]) => {
        const matcher = args.length > 1 ? (args[0] as { command?: unknown }) : undefined
        const key = typeof matcher?.command === 'string' ? `${event}:${matcher.command}` : event
        hooks.set(key, args.at(-1) as Hook)
      }, opts.options ?? {})
    },
  }
}

/** register を読み込んだ擬似エンジンを返す。 */
export function loadMod(register: Register, opts: FakeEngineOptions) {
  const engine = makeEngine(opts)
  engine.register(register)
  return engine
}

/** 子プロセスを起動し、stdout / stderr の塊を届いた順に返す（$.process.spawn と同じ形）。 */
async function* spawnChunks(init: ProcessSpawnInit, env: Record<string, string>): AsyncGenerator<ProcessSpawnChunk> {
  const [cmd = '', ...args] = init.argv
  const child = spawn(cmd, args, { cwd: init.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const queue: Array<ProcessSpawnChunk | null> = []
  let wake: (() => void) | undefined
  const push = (c: ProcessSpawnChunk | null) => {
    queue.push(c)
    wake?.()
  }
  child.stdout.on('data', (b: Buffer) => push({ stream: 'stdout', text: b.toString('utf8') }))
  child.stderr.on('data', (b: Buffer) => push({ stream: 'stderr', text: b.toString('utf8') }))
  child.on('close', () => push(null))
  child.on('error', () => push(null))
  child.stdin.end(init.input ?? '')
  while (true) {
    const c = queue.shift()
    if (c === undefined) {
      await new Promise<void>((r) => {
        wake = r
      })
      wake = undefined
      continue
    }
    if (c === null) return
    yield c
  }
}
