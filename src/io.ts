// hook モジュールの実行環境は Node も DOM も持たず、ファイルやプロセスには `$`（エンジン）経由でしか
// 触れない。ポートしたロジックはすべてこの Io インターフェースだけに依存し、実環境では
// engine-io.ts が `$` から、テストでは tests/helpers/node-io.ts が Node から実装する。

export type EnvVars = {
  HOME?: string
  PATH?: string
  CLAUDE_FEEDBACK_DIR?: string
  DOGWOOD_BIN?: string
  TERM_PROGRAM?: string
  __CFBundleIdentifier?: string
}

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }
export type Stat = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }

export type RunOptions = {
  cwd?: string
  /** ホストの環境変数の上に重ねる値。 */
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** タイムアウトで打ち切られた。 */
  timedOut: boolean
  /** 起動できなかった、などの理由（exitCode は 1）。 */
  error?: string
}

export interface Io {
  /** フックが参照する環境変数のスナップショット。 */
  readonly env: Readonly<EnvVars>
  /** CLAUDE_PROJECT_DIR 相当（セッションのルート）。 */
  readonly projectDir: string
  /** セッションの作業ディレクトリ。 */
  readonly cwd: string
  /** プラグインの同梱ファイルのルート（scripts/dogwood/ などを探す起点）。 */
  readonly pluginRoot: string
  readFile(path: string): Promise<string | undefined>
  /** 親ディレクトリも作って書き込む。 */
  writeFile(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<Stat | undefined>
  /** ディレクトリ直下のエントリ。無ければ空配列。 */
  list(path: string): Promise<DirEntry[]>
  isExecutable(path: string): Promise<boolean>
  /** 存在しなくてもよい。 */
  removeFiles(paths: readonly string[]): Promise<void>
  /** 空のディレクトリだけ消す。消せなければ黙って何もしない。 */
  removeDir(path: string): Promise<void>
  removeTree(path: string): Promise<void>
  /** シェルを介さず argv をそのまま実行する。例外は投げない。 */
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  /** エポックからのミリ秒。 */
  now(): Promise<number>
}

/** Hook スクリプト相当の結果（classic コマンド hook の終了コード・stdout・stderr）。 */
export type ScriptResult = { exitCode: number; stdout: string; stderr: string }

export const ok = (stdout = '', stderr = ''): ScriptResult => ({ exitCode: 0, stdout, stderr })
