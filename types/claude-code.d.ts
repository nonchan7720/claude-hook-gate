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

  export type Timer = { cancel(): void }

  /** エンジンインターフェース（`$`）のうち、このプラグインが使う名詞とメソッド。 */
  export interface Engine {
    plugin: { root: string }
    session: {
      id(): Promise<string>
      root(): Promise<string>
      cwd(): Promise<string>
    }
    env: { get(name: string): Promise<string | undefined> }
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): Timer }
    ui: {
      status(text: string | undefined): void
      /** `ui.render` を描き直させる（毎秒 10 回まで）。 */
      invalidate(event: 'ui.render'): void
    }
    fs: {
      read(path: string): Promise<string>
      write(path: string, text: string): Promise<void>
      list(path?: string): Promise<FsEntry[]>
      exists(path: string): Promise<boolean>
      stat(path: string): Promise<FsStat>
    }
    process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
    /** スラッシュコマンドの登録。 */
    command: { register(command: { name: string; description: string; argumentHint?: string }): Promise<unknown> }
  }

  /** hook に渡るイベント入力（classic hook は stdin の JSON、tool.call はそのツールの入力）。 */
  export type HookEvent = Readonly<Record<string, unknown>>
  /** hook の戻り値（イベントごとの結果。ここでは緩く扱う）。 */
  export type HookResult = Readonly<Record<string, unknown>>
  export type Next = (e: HookEvent) => Promise<HookResult>
  export type Hook = ($: Engine, e: HookEvent, next: Next) => Promise<HookResult> | HookResult

  /** `ui.render` が返す、素のデータの木（Box / Text と文字列だけを使う）。 */
  export type RenderElement = {
    type: 'Box' | 'Text'
    props?: Record<string, string | number | boolean>
    children?: Array<RenderElement | string>
  }
  /** `ui.render` の AbovePrompt（プロンプトの上の帯）の入力。 */
  export type AbovePromptInput = {
    surface: string
    component: 'AbovePrompt'
    requestId: string
    props: {
      /** アンケートが帯を使っている間 true。このときは帯を譲る。 */
      hasSurvey: boolean
      isWorking: boolean
    }
  }
  export type RenderHook = ($: Engine, e: AbovePromptInput, next: (e: AbovePromptInput) => Promise<RenderElement>) => Promise<RenderElement> | RenderElement

  export interface On {
    (event: 'ui.render', matcher: { component: 'AbovePrompt' }, hook: RenderHook): unknown
    (event: 'command.run', matcher: { command: string }, hook: Hook): unknown
    (event: string, hook: Hook): unknown
  }
  export type Register = (on: On, options: PluginOptions) => unknown
}
