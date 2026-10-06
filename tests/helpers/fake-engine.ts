// テスト用の擬似エンジン: register() が登録する hook を保持し、`$`（Engine）を Node の fs / プロセスで実装する。
import * as fs from 'node:fs'
import type { Engine, Hook, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { makeIo, REPO_ROOT } from './node-io.ts'

export type FakeEngineOptions = {
  projectDir: string
  env?: Record<string, string>
  options?: PluginOptions
  sessionId?: string
}

export type FakeEngine = {
  $: Engine
  call: (event: string, e: HookEvent, next?: (e: HookEvent) => Promise<HookResult>) => Promise<HookResult>
  register: (register: Register) => void
}

export function makeEngine(opts: FakeEngineOptions): FakeEngine {
  const env = { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', ...opts.env } as Record<string, string | undefined>
  const io = makeIo({ projectDir: opts.projectDir })
  const $: Engine = {
    plugin: { root: REPO_ROOT },
    session: { id: async () => opts.sessionId ?? 'sess-1', root: async () => opts.projectDir, cwd: async () => opts.projectDir },
    env: { get: async (name) => env[name] },
    clock: { now: async () => Date.now() },
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
        const r = await io.run(argv, init)
        if (r.error !== undefined) throw new Error(r.error)
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      },
    },
  }
  const hooks = new Map<string, Hook>()
  return {
    $,
    call: async (event, e, next = async () => ({})) => {
      const hook = hooks.get(event)
      if (!hook) throw new Error(`no hook for ${event}`)
      return hook($, e, next)
    },
    register: (register) => {
      register((event, hook) => hooks.set(event, hook), opts.options ?? {})
    },
  }
}

/** register を読み込んだ擬似エンジンを返す。 */
export function loadMod(register: Register, opts: FakeEngineOptions) {
  const engine = makeEngine(opts)
  engine.register(register)
  return engine
}
