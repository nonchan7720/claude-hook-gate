// `claude-code` モジュールの最小限の型宣言。hooks/register.ts と src/engine-io.ts が実際に使う範囲だけを
// 手書きしている。
//
// 本物の型定義は Claude Code が `.claude-plugin/types/` に生成する（gitignore 済み）ため、CI など
// Claude Code が無い環境では存在しない。そこで tsconfig.json の `paths` でこのファイルを指し、
// `tsc --noEmit` が環境に依存せず通るようにしている。実行時の `import type` は消えるので、実際の
// 挙動には影響しない。エンジンの API が変わったらここも合わせる。
declare module 'claude-code' {
  export type PluginOptions = Readonly<Record<string, unknown>>

  export type FsEntry = {
    name: string
    kind: 'file' | 'dir' | 'other'
    size: number
    mtimeMs: number
    isLink: boolean
  }

  export type FsStat = {
    kind: 'file' | 'dir' | 'other'
    size: number
    mtimeMs: number
    isLink: boolean
  }

  export type ProcessRunInit = {
    cwd?: string
    env?: Record<string, string>
    stdin?: string
    timeoutMs?: number
  }

  export type ProcessRunResult = {
    exitCode: number
    stdout: string
    stderr: string
    isStdoutTruncated?: boolean
    isStderrTruncated?: boolean
  }

  /** エンジンインターフェース（`$`）のうち、このプラグインが使う名詞とメソッド。 */
  export interface Engine {
    plugin: { root: string }
    session: {
      id(): Promise<string>
      root(): Promise<string>
      cwd(): Promise<string>
    }
    env: { get(name: string): Promise<string | undefined> }
    clock: { now(): Promise<number> }
    fs: {
      read(path: string): Promise<string>
      write(path: string, text: string): Promise<void>
      list(path?: string): Promise<FsEntry[]>
      exists(path: string): Promise<boolean>
      stat(path: string): Promise<FsStat>
    }
    process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  }

  /** hook に渡るイベント入力（classic hook は stdin の JSON、tool.call はそのツールの入力）。 */
  export type HookEvent = Readonly<Record<string, unknown>>
  /** hook の戻り値（イベントごとの結果。ここでは緩く扱う）。 */
  export type HookResult = Readonly<Record<string, unknown>>
  export type Next = (e: HookEvent) => Promise<HookResult>
  export type Hook = ($: Engine, e: HookEvent, next: Next) => Promise<HookResult> | HookResult
  export type On = (event: string, hook: Hook) => unknown
  export type Register = (on: On, options: PluginOptions) => unknown
}
