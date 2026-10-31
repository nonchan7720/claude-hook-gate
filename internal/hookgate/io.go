package hookgate

// hook モジュールの実行環境は Io インターフェースだけに依存する。実環境では osio.go（OS のファイルとプロセス）が、
// テストでは helpers_test.go が実装する。TS 版の Promise は無く、すべて同期。

// EnvVars はフックが参照する環境変数のスナップショット。空文字は未設定と同じ扱い（TS の undefined / ” はどちらも偽として使われる）。
type EnvVars struct {
	Home              string // HOME
	Path              string // PATH
	ClaudeFeedbackDir string // CLAUDE_FEEDBACK_DIR
	DogwoodBin        string // DOGWOOD_BIN
	TermProgram       string // TERM_PROGRAM
	CFBundleID        string // __CFBundleIdentifier
	// FeedbackGateLang は FEEDBACK_GATE_LANG。メッセージの言語の判定に使う（i18n.go）。このプラグイン専用の上書き。
	FeedbackGateLang string
	LCAll            string // LC_ALL
	LCMessages       string // LC_MESSAGES
	LangEnv          string // LANG
	// FeedbackGateAskAgentTypes は FEEDBACK_GATE_ASK_AGENT_TYPES: agentLaunchGuard が確認する subagent_type の一覧（`,` / `;` 区切り）。
	// 未設定なら AskAgentTypes の既定。
	FeedbackGateAskAgentTypes string
	// FeedbackGateAllowRecipients は FEEDBACK_GATE_ALLOW_RECIPIENTS: agentLaunchGuard が確認なしで送ってよい宛先の一覧（同上）。
	// 未設定なら AllowRecipients の既定。
	FeedbackGateAllowRecipients string
	// FeedbackGateHookSource は FEEDBACK_GATE_HOOK_SOURCE: Codex の hook がどの層から呼ばれたか（plugins/codex/scripts/hook.sh が
	// 設定する）。"plugin" はプラグイン同梱の hooks.json（Codex が PLUGIN_ROOT を渡す）、それ以外は ~/.codex/hooks.json などへの写し。
	FeedbackGateHookSource string
}

// Kind はファイルの種類。
type Kind string

// Kind の値。
const (
	KindFile  Kind = "file"
	KindDir   Kind = "dir"
	KindOther Kind = "other"
)

// DirEntry は List の 1 エントリ。MtimeMs はミリ秒（ファイル以外は 0）。
type DirEntry struct {
	Name    string
	Kind    Kind
	MtimeMs int64
}

// Stat は Io.Stat の結果。
type Stat struct {
	Kind    Kind
	Size    int64
	MtimeMs int64
}

// RunOptions は Io.Run の引数。ゼロ値はすべて「指定なし」。
type RunOptions struct {
	Cwd string
	// Env はホストの環境変数の上に重ねる値。
	Env   map[string]string
	Stdin string
	// TimeoutMs が 0 のときは打ち切らない。
	TimeoutMs int64
	// DieWithParent は、hook のプロセスが SIGKILL などで突然死んだときに、子のプロセスグループも道連れにしたいときに立てる
	// （unix のみ）。子の fd 3 に「親が生きている間だけ開いているパイプ」を渡す。子のシェルがこれを見張る
	// （deathWatchSnippet、osio_unix.go）。Windows では何もしない。
	DieWithParent bool
}

// RunResult は Io.Run の結果。
type RunResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	// TimedOut はタイムアウトで打ち切られた。
	TimedOut bool
	// Error は起動できなかった、などの理由（ExitCode は 1）。空なら無し。
	Error string
}

// Io は hook が触れる外界のすべて。
type Io interface {
	// Env はフックが参照する環境変数のスナップショット。
	Env() EnvVars
	// Lang は hook が出すメッセージの言語。
	Lang() Lang
	// AutoCount は違反を検出したら feedback ルールの count を自動で上げるか（TS の undefined は true 扱い）。
	AutoCount() bool
	// ProjectDir は CLAUDE_PROJECT_DIR 相当（セッションのルート）。
	ProjectDir() string
	// Cwd はセッションの作業ディレクトリ。
	Cwd() string
	// PluginRoot はプラグインの同梱ファイルのルート。
	PluginRoot() string
	// ConfigDirNames は設定ディレクトリ名の候補（優先順）。Claude Code は ['.claude', '.agents']、Codex は逆。
	ConfigDirNames() []string
	// ProjectConfigDir はプロジェクトの設定ディレクトリ（候補のうち最初に存在するもの、無ければ先頭）。
	ProjectConfigDir() string
	// HomeConfigDir は HOME の設定ディレクトリ（同上）。
	HomeConfigDir() string
	// AppName はデスクトップ通知の見出しに使うアプリ名。空なら既定（Claude Code。Codex プラグインは Codex）。
	AppName() string

	// ReadFile は読めなければ ("", false)。
	ReadFile(path string) (string, bool)
	// WriteFile は親ディレクトリも作って書き込む。
	WriteFile(path, text string) error
	Exists(path string) bool
	// Stat は無ければ (Stat{}, false)。
	Stat(path string) (Stat, bool)
	// List はディレクトリ直下のエントリ。無ければ空。
	List(path string) []DirEntry
	IsExecutable(path string) bool
	// RemoveFiles は存在しなくてもよい。
	RemoveFiles(paths []string)
	// RemoveDir は空のディレクトリだけ消す。消せなければ黙って何もしない。
	RemoveDir(path string)
	RemoveTree(path string)
	// Run はシェルを介さず argv をそのまま実行する。失敗は RunResult で返す。
	Run(argv []string, opts RunOptions) RunResult
	// Now はエポックからのミリ秒。
	Now() int64
	// Progress はプロンプト下のステータス行に処理中だけの 1 行を出す。"" で消す（TS の undefined）。CLI では何もしない。
	Progress(text string)
	// Result はステータス行に終わった結果の 1 行を残す。"" で消す。
	Result(text string)
	// Redraw はプロンプトの上の帯（実行中の一覧）を描き直させる。
	Redraw()
	// Every は ms ごとに fn を呼ぶ。戻り値の関数で止める。
	Every(ms int64, fn func()) (stop func())
}

// IoProps は Io の値だけのプロパティ。Io の実装はこれを埋め込むと getter が揃う。
type IoProps struct {
	EnvVars       EnvVars
	Language      Lang
	NoAutoCount   bool // autoCount: false
	Project       string
	WorkDir       string
	Plugin        string
	ConfigNames   []string
	ProjectConfig string
	HomeConfig    string
	App           string
}

// Env を返す。
func (p IoProps) Env() EnvVars { return p.EnvVars }

// Lang を返す。
func (p IoProps) Lang() Lang { return p.Language }

// AutoCount を返す（既定 true）。
func (p IoProps) AutoCount() bool { return !p.NoAutoCount }

// ProjectDir を返す。
func (p IoProps) ProjectDir() string { return p.Project }

// Cwd を返す。
func (p IoProps) Cwd() string { return p.WorkDir }

// PluginRoot を返す。
func (p IoProps) PluginRoot() string { return p.Plugin }

// ConfigDirNames を返す。
func (p IoProps) ConfigDirNames() []string { return p.ConfigNames }

// ProjectConfigDir を返す。
func (p IoProps) ProjectConfigDir() string { return p.ProjectConfig }

// HomeConfigDir を返す。
func (p IoProps) HomeConfigDir() string { return p.HomeConfig }

// AppName を返す。
func (p IoProps) AppName() string { return p.App }

// ScriptResult は Hook スクリプト相当の結果（classic コマンド hook の終了コード・stdout・stderr）。
//
// ReportConsumed: gate が成功報告の印を消費し、検証を走らせずに Stop を通した（成功報告の直後の Stop だった）。
// Report / HasReport: gate の checks フェーズの最終結果の要約（サブエージェントの結果を呼び出し元へ渡すのに使う）。
// TS の `report?: string` に対応し、空文字の report と未設定を HasReport で区別する。
type ScriptResult struct {
	ExitCode       int
	Stdout         string
	Stderr         string
	ReportConsumed bool
	Report         string
	HasReport      bool
}

// Ok は終了コード 0 の結果。
func Ok(stdout, stderr string) ScriptResult {
	return ScriptResult{ExitCode: 0, Stdout: stdout, Stderr: stderr}
}
