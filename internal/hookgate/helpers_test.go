package hookgate

// tests/helpers/node-io.ts と tests/helpers/gate.ts（gate 非依存の部分）の移植。
// gate 本体（Gate / RunGate）に依存する gate / newGate / rules / checks と、偽 dogwood（writeFakeDogwood / readCalls）は
// gate の移植担当が別のヘルパーファイルに足す。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// RepoRoot はリポジトリのルート（tests/helpers/node-io.ts の REPO_ROOT）。
var RepoRoot = func() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}()

// MissingDogwoodBin は存在しない dogwood のパス。
// 既定ポリシーは policy: を書かなくても適用されるので、DOGWOOD_BIN を差さないと PATH や ~/.cargo/bin の実バイナリを
// 拾ってしまう。既定で存在しないパスを差して「dogwood 未導入」を作り、偽バイナリを明示したテストだけが判定経路に乗るようにする。
var MissingDogwoodBin = filepath.Join(RepoRoot, "tests", "no-such-dogwood")

// TestHome は共有・直列化のロックなどが置かれる既定の HOME。本物の HOME を汚さないよう一時ディレクトリで、
// TestMain が作り、終了時に消す。
var TestHome string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "gate-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		resolved = dir
	}
	TestHome = resolved
	code := m.Run()
	_ = os.RemoveAll(TestHome)
	os.Exit(code)
}

// SharedDirOf は projectDir（と HOME）に対応する共有ディレクトリ（SharedDir）。home を省略すると TestHome。
func SharedDirOf(projectDir string, home ...string) string {
	h := TestHome
	if len(home) > 0 {
		h = home[0]
	}
	return SharedDir(MakeIo(IoOpts{ProjectDir: projectDir, Env: EnvVars{Home: h}}))
}

// IoOpts は MakeIo の引数（NodeIoOptions）。ゼロ値は「指定なし」。
type IoOpts struct {
	ProjectDir string
	Cwd        string
	PluginRoot string
	// Env は既定（HOME=TestHome, PATH=現在の PATH, DOGWOOD_BIN=MissingDogwoodBin）の上に重ねる。空文字の項目は上書きしない。
	Env EnvVars
	// ClearHome を立てると HOME を空にする（Env.Home では空にできないため）。
	ClearHome bool
	// Lang は省略時 ja（テストの期待値は日本語で書かれている）。
	Lang Lang
	// AutoCount が nil なら既定（true）。
	AutoCount *bool
	// Now は現在時刻（ミリ秒）を差し替える。
	Now func() int64
	// ProgressLog は Progress() に渡されたテキストを順に記録する（"" は TS の undefined）。
	ProgressLog *[]string
	// ResultLog は Result() に渡されたテキストを順に記録する。
	ResultLog *[]string
	// BandLog は Redraw() のたびに、その時点で帯に描かれる内容（行を改行でつないだもの。帯が出ないなら ""）を記録する。
	BandLog *[]string
	// Every は every() を差し替える（時間を注入するため）。省略時は time.Ticker。
	Every func(ms int64, fn func()) func()
	// ConfigDirNames は設定ディレクトリ名の候補。省略時は Claude Code のもの。
	ConfigDirNames []string
	// AppName は Io.AppName。
	AppName string
}

type testIo struct {
	*osIo
	opts IoOpts
}

// MakeIo はテスト用の Io を作る。
func MakeIo(opts IoOpts) Io {
	env := EnvVars{Home: TestHome, Path: os.Getenv("PATH"), DogwoodBin: MissingDogwoodBin}
	o := opts.Env
	for _, f := range []struct{ dst, src *string }{
		{&env.Home, &o.Home}, {&env.Path, &o.Path}, {&env.ClaudeFeedbackDir, &o.ClaudeFeedbackDir}, {&env.DogwoodBin, &o.DogwoodBin},
		{&env.TermProgram, &o.TermProgram}, {&env.CFBundleID, &o.CFBundleID}, {&env.FeedbackGateLang, &o.FeedbackGateLang},
		{&env.LCAll, &o.LCAll}, {&env.LCMessages, &o.LCMessages}, {&env.LangEnv, &o.LangEnv},
		{&env.FeedbackGateAskAgentTypes, &o.FeedbackGateAskAgentTypes}, {&env.FeedbackGateAllowRecipients, &o.FeedbackGateAllowRecipients},
	} {
		if *f.src != "" {
			*f.dst = *f.src
		}
	}
	if opts.ClearHome {
		env.Home = ""
	}
	lang := opts.Lang
	if lang == "" {
		lang = LangJA
	}
	names := opts.ConfigDirNames
	if names == nil {
		names = ClaudeConfigDirs
	}
	cwd := opts.Cwd
	if cwd == "" {
		cwd = opts.ProjectDir
	}
	pluginRoot := opts.PluginRoot
	if pluginRoot == "" {
		pluginRoot = RepoRoot
	}
	homeBase := env.Home
	if homeBase == "" {
		homeBase = TestHome
	}
	return &testIo{
		osIo: &osIo{IoProps: IoProps{
			EnvVars:       env,
			Language:      lang,
			NoAutoCount:   opts.AutoCount != nil && !*opts.AutoCount,
			Project:       opts.ProjectDir,
			WorkDir:       cwd,
			Plugin:        pluginRoot,
			ConfigNames:   names,
			ProjectConfig: PickConfigDirSync(names, opts.ProjectDir),
			HomeConfig:    PickConfigDirSync(names, homeBase),
			App:           opts.AppName,
		}},
		opts: opts,
	}
}

func (t *testIo) now() int64 {
	if t.opts.Now != nil {
		return t.opts.Now()
	}
	return time.Now().UnixMilli()
}

func (t *testIo) Now() int64 { return t.now() }

func (t *testIo) Progress(text string) {
	if t.opts.ProgressLog != nil {
		*t.opts.ProgressLog = append(*t.opts.ProgressLog, text)
	}
}

func (t *testIo) Result(text string) {
	if t.opts.ResultLog != nil {
		*t.opts.ResultLog = append(*t.opts.ResultLog, text)
	}
}

func (t *testIo) Redraw() {
	if t.opts.BandLog != nil {
		*t.opts.BandLog = append(*t.opts.BandLog, snapshotBand(t.opts.ProjectDir, t.now(), t.Lang()))
	}
}

func (t *testIo) Every(ms int64, fn func()) func() {
	if t.opts.Every != nil {
		return t.opts.Every(ms, fn)
	}
	tick := time.NewTicker(time.Duration(ms) * time.Millisecond)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-tick.C:
				fn()
			case <-done:
				return
			}
		}
	}()
	var once bool
	return func() {
		if !once {
			once = true
			tick.Stop()
			close(done)
		}
	}
}

// Run は timeoutMs の指定が無ければ 30 秒で打ち切る（テストがハングしないように）。
func (t *testIo) Run(argv []string, opts RunOptions) RunResult {
	if opts.TimeoutMs == 0 {
		opts.TimeoutMs = 30_000
	}
	return t.osIo.Run(argv, opts)
}

// snapshotBand は共有の実行中一覧のファイルを読み、帯に描かれる内容を返す（Redraw の時点の記録用）。帯が出ないなら ""。
func snapshotBand(projectDir string, now int64, lang Lang) string {
	dir := filepath.Join(projectDir, ".claude", ".gate-status", "running")
	var texts []string
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if b, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
				texts = append(texts, string(b))
			}
		}
	}
	entries := MergeRunning(texts, now)
	if !HasRunningBand(entries) {
		return ""
	}
	return strings.Join(RunningLines(entries, now, lang), "\n")
}

// TmpDir は一時ディレクトリを作る（realpath 済み）。
func TmpDir(prefix ...string) string {
	p := "gate-test-"
	if len(prefix) > 0 {
		p = prefix[0]
	}
	dir, err := os.MkdirTemp("", p)
	must(err)
	resolved, err := filepath.EvalSymlinks(dir)
	must(err)
	return resolved
}

// RmTree はディレクトリを再帰的に消す。
func RmTree(dir string) { _ = os.RemoveAll(dir) }

// WithTmp はテスト用の一時ディレクトリを作り、body の後に必ず消す。
func WithTmp(body func(dir string)) {
	dir := TmpDir()
	defer RmTree(dir)
	body(dir)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

// WaitForSharedLock は実行側のロック（<ハッシュ>.*.run/info.json）が現れるまで待つ。sleep で「先に始まっている」ことを仮定しないための順序付け。
// timeout を省略すると 10 秒。
func WaitForSharedLock(proj string, timeout ...time.Duration) error {
	limit := 10 * time.Second
	if len(timeout) > 0 {
		limit = timeout[0]
	}
	dir := SharedDirOf(proj)
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if strings.HasSuffix(e.Name(), ".run") {
					if _, err := os.Stat(filepath.Join(dir, e.Name(), "info.json")); err == nil {
						return nil
					}
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("shared lock did not appear")
}

// ---- tests/helpers/gate.ts ----

// Touch は空のファイルを作る（親ディレクトリも作る）。
func Touch(parts ...string) string {
	p := filepath.Join(parts...)
	must(os.MkdirAll(filepath.Dir(p), 0o755))
	must(os.WriteFile(p, nil, 0o644))
	return p
}

// Exists はパスが存在するか。
func Exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Read はファイルの中身（読めなければ panic）。
func Read(p string) string {
	b, err := os.ReadFile(p)
	must(err)
	return string(b)
}

// Lines は空白だけの行を除いた行のリスト。
func Lines(p string) []string {
	out := []string{}
	for _, l := range strings.Split(Read(p), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

func writeText(p, text string) {
	must(os.MkdirAll(filepath.Dir(p), 0o755))
	must(os.WriteFile(p, []byte(text), 0o644))
}

// WriteGateYaml は <proj>/.claude/gate.yaml を書く。JSON は YAML のサブセットなので、同梱パーサで読める。
func WriteGateYaml(proj string, obj any) {
	writeText(filepath.Join(proj, ".claude", "gate.yaml"), JSONStringify(obj))
}

func stateDir(proj string) string { return filepath.Join(proj, ".claude", ".gate-status") }

// StatePath は <proj>/.claude/.gate-status/<name>.<id>.<ext>。
func StatePath(proj, name, id, ext string) string {
	return filepath.Join(stateDir(proj), name+"."+id+"."+ext)
}

// WriteChangedFiles は changed_files の状態ファイルを書く。
func WriteChangedFiles(proj, sessionID string, rels ...string) {
	must(os.MkdirAll(stateDir(proj), 0o755))
	var b strings.Builder
	for _, p := range rels {
		b.WriteString(p + "\n")
	}
	must(os.WriteFile(ChangedPath(proj, sessionID), []byte(b.String()), 0o644))
}

// 状態ファイルのパス。
func ChangedPath(proj, id string) string  { return StatePath(proj, "changed_files", id, "txt") }
func SidecarPath(proj, id string) string  { return StatePath(proj, "gate_passed", id, "txt") }
func PendingPath(proj, id string) string  { return StatePath(proj, "gate_pending_checks", id, "json") }
func AttemptsPath(proj, id string) string { return StatePath(proj, "gate_attempts", id, "txt") }
func TracePath(proj, id string) string    { return StatePath(proj, "gate_trace", id, "jsonl") }
func DeferredPath(proj, id string) string { return StatePath(proj, "gate_deferred", id, "json") }

// AttemptsCount は gate_attempts の中身（trim 済み）。
func AttemptsCount(proj, id string) string { return strings.TrimSpace(Read(AttemptsPath(proj, id))) }

// ChangedLines は changed_files の行。
func ChangedLines(proj, id string) []string { return Lines(ChangedPath(proj, id)) }

// ReadPending は gate_pending_checks を読む。
func ReadPending(proj, id string) map[string]map[string][]string {
	var out map[string]map[string][]string
	must(jsonUnmarshal(Read(PendingPath(proj, id)), &out))
	return out
}

// WritePending は gate_pending_checks を書く。
func WritePending(proj, id string, data any) {
	writeText(PendingPath(proj, id), JSONStringify(data))
}

// ReadTraceRecords は gate_trace（jsonl）を読む。無ければ空。
func ReadTraceRecords(proj, id string) []Dict {
	out := []Dict{}
	if !Exists(TracePath(proj, id)) {
		return out
	}
	for _, l := range Lines(TracePath(proj, id)) {
		var d Dict
		must(jsonUnmarshal(l, &d))
		out = append(out, d)
	}
	return out
}

// WriteTraceRecords は gate_trace（jsonl）を書く。
func WriteTraceRecords(proj, id string, records []Dict) {
	var b strings.Builder
	for _, r := range records {
		b.WriteString(JSONStringify(r) + "\n")
	}
	writeText(TracePath(proj, id), b.String())
}

// ReadDeferred は gate_deferred を読む。無ければ空。
func ReadDeferred(proj, id string) []Dict {
	out := []Dict{}
	if Exists(DeferredPath(proj, id)) {
		must(jsonUnmarshal(Read(DeferredPath(proj, id)), &out))
	}
	return out
}

// WriteDeferred は gate_deferred を書く。
func WriteDeferred(proj, id string, entries []any) {
	writeText(DeferredPath(proj, id), JSONStringify(entries))
}

// WritePolicy はポリシーファイルを書く（rel の既定は .claude/policies/gate.dw）。
func WritePolicy(proj string, rel ...string) string {
	r := ".claude/policies/gate.dw"
	if len(rel) > 0 {
		r = rel[0]
	}
	p := filepath.Join(proj, filepath.FromSlash(r))
	writeText(p, "permit (principal, action == Gate::Action::\"Run\", resource);\n")
	return p
}

// SetupReservedCheckProject は "x.py" にマッチするルールが consistency_check "chk" を予約する構成を作る。
func SetupReservedCheckProject(proj, sessionID string, checkRun []any, extraCheck Dict) {
	checks := []any{Dict{"name": "chk", "run": checkRun}}
	if extraCheck != nil {
		checks = append(checks, extraCheck)
	}
	WriteGateYaml(proj, Dict{
		"rules":              []any{Dict{"match": "**/*.py", "run": []any{"true"}, "run_checks": []any{"chk"}}},
		"consistency_checks": checks,
	})
	WriteChangedFiles(proj, sessionID, "x.py")
}

func jsonUnmarshal(text string, v any) error { return json.Unmarshal([]byte(text), v) }
