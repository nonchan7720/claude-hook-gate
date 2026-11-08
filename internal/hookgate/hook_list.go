package hookgate

// `feedback-gate <claude|codex> hook-list [--no-open]`: このプロジェクトで feedback-gate が何をいつ動かすかを、ブラウザの画面で一覧にする。
// gate.yaml（rules / consistency_checks / session_start のそれぞれが動くタイミングとコマンド）と、
// feedback ルール（有効・無効・読めないもの、注入のされ方、enforce の各要素のイベント・条件・コマンド）、プラグイン設定を
// JSON のモデル（HookListModel）にまとめ、webui/hook-list.html に埋め込んだ HTML を書き出してブラウザで開く。
// 画面の描画はすべて webui/hook-list.html の JS が行う。Claude Code の /hook-list（mod、src/hook-list.ts）は
// scripts/hook-list.sh 経由でこのコマンドを呼ぶだけ。
// ルールやゲートのファイルは読むだけで、書くのは一覧の HTML（<homeConfigDir>/feedback-gate/hook-list/<project>.html）だけ。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/nonchan7720/claude-hook-gate/webui"
)

// HookListRunNode は run の要素。Parallel があればその中身（Cmd などは空）。Notes は timeout / share / files の注記。
type HookListRunNode struct {
	Cmd      string            `json:"cmd,omitempty"`
	Name     string            `json:"name,omitempty"`
	Notes    []string          `json:"notes,omitempty"`
	Parallel []HookListRunNode `json:"parallel,omitempty"`
}

// HookListPair は画面に `key: value` で出す 1 組。
type HookListPair [2]string

// HookListGateRule は gate.yaml の rules の 1 要素。
type HookListGateRule struct {
	Match     []string          `json:"match"`
	Options   []HookListPair    `json:"options"`
	Run       []HookListRunNode `json:"run"`
	RunChecks []string          `json:"runChecks"`
}

// HookListGateCheck は consistency_checks の 1 要素。Referenced はどれかの rule の run_checks に名前があるか。
type HookListGateCheck struct {
	Name       string            `json:"name"`
	Referenced bool              `json:"referenced"`
	Options    []HookListPair    `json:"options"`
	Run        []HookListRunNode `json:"run"`
}

// HookListGate は gate.yaml。Path が nil なら gate.yaml が無い、Error があれば読めない。
type HookListGate struct {
	Path         *string             `json:"path"`
	Error        *string             `json:"error"`
	Rules        []HookListGateRule  `json:"rules"`
	Checks       []HookListGateCheck `json:"checks"`
	SessionStart []HookListRunNode   `json:"sessionStart"`
	Settings     []HookListPair      `json:"settings"`
}

// HookListInject はルールがいつ context に入るか（Kind: none / prompt / files）。
type HookListInject struct {
	Kind    string   `json:"kind"`
	Files   []string `json:"files"`
	Exclude []string `json:"exclude"`
}

// HookListEnforce は enforce の 1 要素。Severity は count と明示から決まる実際の重さ。
type HookListEnforce struct {
	Event    string         `json:"event"`
	Severity string         `json:"severity"`
	Fields   []HookListPair `json:"fields"`
}

// HookListRule は有効な feedback ルール 1 つ。
type HookListRule struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Scope       string            `json:"scope"`
	Count       int               `json:"count"`
	Level       string            `json:"level"`
	Inject      HookListInject    `json:"inject"`
	Enforce     []HookListEnforce `json:"enforce"`
	Path        string            `json:"path"`
}

// HookListInactive は無効になっている feedback ルールと、その理由。
type HookListInactive struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
	Path   string `json:"path"`
}

// HookListBroken は読めない feedback ルール。
type HookListBroken struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// HookListFeedback は feedback ルールの一覧。
type HookListFeedback struct {
	Rules    []HookListRule     `json:"rules"`
	Inactive []HookListInactive `json:"inactive"`
	Broken   []HookListBroken   `json:"broken"`
}

// HookListOptions はプラグイン設定のうち、hook の動き方を変えるもの。
type HookListOptions struct {
	AgentLaunchGuard bool   `json:"agentLaunchGuard"`
	AutoCount        bool   `json:"autoCount"`
	Language         string `json:"language"`
}

// HookListModel は画面（webui/hook-list.html）に埋め込むデータ。Labels は locales の hookList.*（点区切りのキー）。
type HookListModel struct {
	Version     int               `json:"version"`
	Project     string            `json:"project"`
	GeneratedAt string            `json:"generatedAt"`
	Lang        string            `json:"lang"`
	Labels      map[string]string `json:"labels"`
	Gate        HookListGate      `json:"gate"`
	Feedback    HookListFeedback  `json:"feedback"`
	Options     HookListOptions   `json:"options"`
}

// hlList は文字列か配列を文字列の配列にする（それ以外の値は 1 要素に、空・偽は空）。
func hlList(v any) []string {
	if arr, ok := v.([]any); ok {
		out := make([]string, 0, len(arr))
		for _, e := range arr {
			out = append(out, Str(e))
		}
		return out
	}
	if Truthy(v) {
		return []string{Str(v)}
	}
	return []string{}
}

// HookListRunNodes は run の要素を HookListRunNode にする。cmd の無い要素は捨てる。
func HookListRunNodes(items any) []HookListRunNode {
	out := []HookListRunNode{}
	arr, _ := items.([]any)
	for _, item := range arr {
		d, isDict := AsDict(item)
		if isDict {
			if par, ok := d["parallel"].([]any); ok {
				out = append(out, HookListRunNode{Parallel: HookListRunNodes(par)})
				continue
			}
		} else {
			d = Dict{"cmd": item}
		}
		if !Truthy(d["cmd"]) {
			continue
		}
		notes := []string{}
		if Truthy(d["timeout"]) {
			notes = append(notes, fmt.Sprintf("timeout %ss", Str(d["timeout"])))
		}
		if d["share"] == false {
			notes = append(notes, "share: false")
		}
		if d["files"] == false {
			notes = append(notes, "files: false")
		}
		node := HookListRunNode{Cmd: Str(d["cmd"]), Notes: notes}
		if Truthy(d["name"]) {
			node.Name = Str(d["name"])
		}
		out = append(out, node)
	}
	return out
}

// hlOptionPairs は rule / check の実行場所・timeout・policy。
func hlOptionPairs(d Dict) []HookListPair {
	out := []HookListPair{}
	if Truthy(d["dir"]) {
		out = append(out, HookListPair{"dir", Str(d["dir"])})
	}
	if Truthy(d["per_file_dir"]) {
		out = append(out, HookListPair{"per_file_dir", Str(d["per_file_dir"])})
	}
	if Truthy(d["timeout"]) {
		out = append(out, HookListPair{"timeout", Str(d["timeout"]) + "s"})
	}
	if d["policy"] == false {
		out = append(out, HookListPair{"policy", "false"})
	} else if Truthy(d["policy"]) {
		out = append(out, HookListPair{"policy", Str(d["policy"])})
	}
	return out
}

// hlRunChecks は rule の run_checks。gate はリストしか受け付けない（gateListOf）ので、それ以外は参照なしとして扱う。
func hlRunChecks(v any) []string {
	if _, ok := v.([]any); !ok {
		return []string{}
	}
	return hlList(v)
}

func hlDicts(v any) []Dict {
	arr, _ := v.([]any)
	out := make([]Dict, 0, len(arr))
	for _, e := range arr {
		d, ok := AsDict(e)
		if !ok {
			d = Dict{}
		}
		out = append(out, d)
	}
	return out
}

// HookListGateModel は gate.yaml（読んだ値）をモデルにする。path が "" なら gate.yaml が無い、errMsg があれば読めない。
func HookListGateModel(cfg any, path, errMsg string) HookListGate {
	g := HookListGate{Rules: []HookListGateRule{}, Checks: []HookListGateCheck{}, SessionStart: []HookListRunNode{}, Settings: []HookListPair{}}
	if path == "" {
		return g
	}
	g.Path = &path
	if errMsg != "" {
		g.Error = &errMsg
		return g
	}
	c, ok := AsDict(cfg)
	if !ok {
		c = Dict{}
	}
	referenced := map[string]bool{}
	for _, r := range hlDicts(c["rules"]) {
		for _, name := range hlRunChecks(r["run_checks"]) {
			referenced[name] = true
		}
		g.Rules = append(g.Rules, HookListGateRule{Match: hlList(r["match"]), Options: hlOptionPairs(r), Run: HookListRunNodes(r["run"]), RunChecks: hlRunChecks(r["run_checks"])})
	}
	for _, ch := range hlDicts(c["consistency_checks"]) {
		name := "?"
		if Truthy(ch["name"]) {
			name = Str(ch["name"])
		}
		g.Checks = append(g.Checks, HookListGateCheck{Name: name, Referenced: referenced[name], Options: hlOptionPairs(ch), Run: HookListRunNodes(ch["run"])})
	}
	// gate と同じ読み方（parseSessionStartItem）をする。gate が捨てる要素（cmd が無い・空・文字列でない）は出さない。
	starts, _ := c["session_start"].([]any)
	for _, raw := range starts {
		item, ok := parseSessionStartItem(raw)
		if !ok {
			continue
		}
		notes := []string{}
		if item.hasOn {
			notes = append(notes, "on: "+strings.Join(item.on, ", "))
		}
		if item.background {
			notes = append(notes, "background")
		}
		notes = append(notes, "timeout "+JSNumber(item.timeout)+"s")
		g.SessionStart = append(g.SessionStart, HookListRunNode{Cmd: item.cmd, Name: item.name, Notes: notes})
	}
	for _, key := range []string{"max_parallel", "report_success", "policy"} {
		if v, ok := c[key]; ok && v != nil {
			g.Settings = append(g.Settings, HookListPair{key, Str(v)})
		}
	}
	return g
}

// enforce の要素から画面に出すキー（この順）。hlListKeys は glob の配列になりうるので `, ` でつなぐ。
var (
	hlEnforceKeys = []string{"path", "exclude_path", "changed", "when", "unless", "check", "absent_sibling", "absent_glob", "require_sibling", "message"}
	hlListKeys    = map[string]bool{"path": true, "exclude_path": true, "changed": true, "absent_sibling": true, "absent_glob": true, "require_sibling": true}
)

func hlLevel(count int) string {
	switch {
	case count >= 5:
		return "deny"
	case count >= 3:
		return "confirmed"
	}
	return "provisional"
}

func hlNonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// HookListRuleModel は feedback ルールをモデルにする。projectDirs の下にあるルールはプロジェクトのもの。
func HookListRuleModel(rule Rule, projectDirs []string) HookListRule {
	inject := HookListInject{Kind: "none", Files: []string{}, Exclude: []string{}}
	if rule.Count >= 3 {
		if len(rule.Files) == 0 {
			inject.Kind = "prompt"
		} else {
			inject = HookListInject{Kind: "files", Files: hlNonNil(rule.Files), Exclude: hlNonNil(rule.ExcludeFiles)}
		}
	}
	enforce := []HookListEnforce{}
	for _, e := range rule.Enforce {
		event := ""
		if e["event"] != nil {
			event = Str(e["event"])
		}
		fields := []HookListPair{}
		for _, key := range hlEnforceKeys {
			if !Truthy(e[key]) {
				continue
			}
			value := Str(e[key])
			if hlListKeys[key] {
				value = strings.Join(hlList(e[key]), ", ")
			}
			fields = append(fields, HookListPair{key, value})
		}
		enforce = append(enforce, HookListEnforce{Event: event, Severity: ResolveSeverity(rule.Count, e["severity"], event), Fields: fields})
	}
	scope := "global"
	for _, d := range projectDirs {
		if strings.HasPrefix(rule.Path, d+"/") {
			scope = "project"
			break
		}
	}
	return HookListRule{
		Name: rule.Name, Description: rule.Description, Scope: scope, Count: rule.Count, Level: hlLevel(rule.Count),
		Inject: inject, Enforce: enforce, Path: rule.Path,
	}
}

// HookListInactiveReason は無効なルールの理由（src/correct.ts の inactiveReason と同じ文面）。
func HookListInactiveReason(rule Rule, now int64, lang Lang) string {
	t := Tr(lang)
	if rule.Expires != nil && now > *rule.Expires {
		return t("correct.expired", map[string]any{"date": time.UnixMilli(*rule.Expires).UTC().Format("2006-01-02")})
	}
	parts := []string{}
	if len(rule.Projects) > 0 {
		parts = append(parts, "projects")
	}
	if len(rule.WhenExists) > 0 {
		parts = append(parts, "when_exists")
	}
	what := strings.Join(parts, " / ")
	if what == "" {
		what = t("correct.conditions")
	}
	return t("correct.notMatching", map[string]any{"what": what})
}

// hlScanFeedback は ScanRules と同じ読み方（グローバルとプロジェクトをマージし、同名はプロジェクト優先）で、有効・無効・読めないルールに分ける。
// ScanRules と違い、1 つのルールの絞り込み（projects / when_exists の glob）が評価できなくても全体を止めず、そのルールを読めないものとして出す。
// 一覧を出すだけなので、違反・エラーのログ（.errors.jsonl）には何も書かない。
// 無効なルールは src/correct.ts の listInactive と同じく、同名の有効なルールに上書きされているものを除く。
func hlScanFeedback(io Io) ([]Rule, []Rule, []BrokenRule) {
	broken := []BrokenRule{}
	globalDirs := FeedbackDirs(io)
	projectDirs := []string{}
	for _, d := range ProjectFeedbackDirs(io) {
		if !fbContainsString(globalDirs, d) {
			projectDirs = append(projectDirs, d)
		}
	}
	globalRules := fbListRulesInAll(io, globalDirs, &broken)
	projectRules := fbListRulesInAll(io, projectDirs, &broken)
	overridden := map[string]bool{}
	for _, r := range projectRules {
		overridden[r.Name] = true
	}
	merged, hidden := []Rule{}, []Rule{}
	for _, r := range globalRules {
		if overridden[r.Name] {
			hidden = append(hidden, r)
		} else {
			merged = append(merged, r)
		}
	}
	merged = append(merged, projectRules...)
	active, inactive := []Rule{}, []Rule{}
	activeNames := map[string]bool{}
	for _, r := range merged {
		ok, err := IsRuleActive(io, r)
		switch {
		case err != nil:
			broken = append(broken, BrokenRule{Path: r.Path, Reason: ErrorText(err)})
		case ok:
			active = append(active, r)
			activeNames[r.Name] = true
		default:
			inactive = append(inactive, r)
		}
	}
	// プロジェクトの同名ルールに隠されたグローバルのルールも、有効な同名ルールが無く、それ自体が無効なら無効として出す。
	for _, r := range hidden {
		if activeNames[r.Name] {
			continue
		}
		if ok, err := IsRuleActive(io, r); err == nil && !ok {
			inactive = append(inactive, r)
		}
	}
	return active, inactive, append(broken, fbProblemsOf(active)...)
}

// HookListLabels は locales の hookList.* を、`event.pre_bash` のような点区切りのキーの平らな辞書にする（画面の文言）。
func HookListLabels(lang Lang) map[string]string {
	out := map[string]string{}
	var walk func(v any, prefix string)
	walk = func(v any, prefix string) {
		m, ok := v.(map[string]any)
		if !ok {
			return
		}
		for k, e := range m {
			if _, nested := e.(map[string]any); nested {
				walk(e, prefix+k+".")
			} else {
				out[prefix+k] = Str(e)
			}
		}
	}
	walk(Resources[lang]["hookList"], "")
	return out
}

// hlReadGate は gate.yaml を読んでモデルにする。
func hlReadGate(io Io) HookListGate {
	path, ok := FindGateYaml(io)
	if !ok {
		return HookListGateModel(nil, "", "")
	}
	text, ok := io.ReadFile(path)
	if !ok {
		return HookListGateModel(nil, path, "read failed")
	}
	cfg, err := ParseYaml(text)
	if err != nil {
		msg, _, _ := strings.Cut(err.Error(), "\n")
		return HookListGateModel(nil, path, msg)
	}
	return HookListGateModel(cfg, path, "")
}

// BuildHookListModel はこのプロジェクトの一覧のモデルを作る（ファイルは読むだけ）。
func BuildHookListModel(io Io, options PluginOptions) (HookListModel, error) {
	project := io.ProjectDir()
	if project == "" {
		project = io.Cwd()
	}
	now := io.Now()
	active, inactive, broken := hlScanFeedback(io)
	projectDirs := ConfigPaths(io, project, "feedback")
	feedback := HookListFeedback{Rules: []HookListRule{}, Inactive: []HookListInactive{}, Broken: []HookListBroken{}}
	for _, r := range active {
		feedback.Rules = append(feedback.Rules, HookListRuleModel(r, projectDirs))
	}
	for _, r := range inactive {
		feedback.Inactive = append(feedback.Inactive, HookListInactive{Name: r.Name, Reason: HookListInactiveReason(r, now, io.Lang()), Path: r.Path})
	}
	for _, b := range broken {
		feedback.Broken = append(feedback.Broken, HookListBroken(b))
	}
	return HookListModel{
		Version:     1,
		Project:     project,
		GeneratedAt: time.UnixMilli(now).UTC().Format("2006-01-02T15:04:05.000Z"),
		Lang:        string(io.Lang()),
		Labels:      HookListLabels(io.Lang()),
		Gate:        hlReadGate(io),
		Feedback:    feedback,
		Options:     HookListOptions{AgentLaunchGuard: options.AgentLaunchGuard, AutoCount: io.AutoCount(), Language: string(io.Lang())},
	}, nil
}

// RenderHookListHTML はモデルを画面（webui/hook-list.html）に埋め込む。json.Marshal は <, >, & と U+2028/2029 を \u で書くので、
// </script> で抜けることはない。
func RenderHookListHTML(model HookListModel) (string, error) {
	data, err := json.Marshal(model)
	if err != nil {
		return "", err
	}
	return strings.Replace(webui.HookListHTML, `"__HOOK_LIST_DATA__"`, string(data), 1), nil
}

var hlSlugRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// hlSlugMax はファイル名に使うプロジェクトのパスの最大長（ハッシュを足しても 255 バイトに十分収まる長さ）。
const hlSlugMax = 80

// HookListPath は書き出す HTML のパス。ファイル名は、プロジェクトのパスを読める形にしたもの（末尾 hlSlugMax 文字）と、
// パス全体のハッシュ（別のプロジェクトが同じ名前にならないように）。同じプロジェクトは同じファイルを上書きする。
func HookListPath(io Io, project string) string {
	slug := strings.Trim(hlSlugRe.ReplaceAllString(project, "-"), "-")
	if len(slug) > hlSlugMax {
		slug = strings.TrimLeft(slug[len(slug)-hlSlugMax:], "-")
	}
	if slug == "" {
		slug = "project"
	}
	sum := sha256.Sum256([]byte(project))
	return Join(io.HomeConfigDir(), "feedback-gate", "hook-list", slug+"-"+hex.EncodeToString(sum[:])[:10]+".html")
}

// hlOpenWait は、ブラウザを開くコマンドの終了を待つ時間。xdg-open は環境によってブラウザを前面で起動して終わるまで待つので、
// それまでに終わらなければ開けたとみなし、止めずにそのまま残す（止めるとブラウザごと終了してしまう）。
const hlOpenWait = 5 * time.Second

// hlStartOpener は argv を起動し、hlOpenWait 以内に終われば終了コードが 0 か、終わらなければ true を返す（テストで差し替える）。
var hlStartOpener = func(argv []string) bool {
	cmd := exec.Command(argv[0], argv[1:]...)
	if err := cmd.Start(); err != nil {
		return false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(hlOpenWait):
		return true
	}
}

// hlOpenInBrowser は file をブラウザで開く。macOS は open、Windows は start、ほかは xdg-open（無ければ wslview）。開けたら true。
func hlOpenInBrowser(io Io, goos, file string) bool {
	var candidates [][]string
	switch goos {
	case "darwin":
		candidates = [][]string{{"open", file}}
	case "windows":
		candidates = [][]string{{"cmd", "/c", "start", "", file}}
	default:
		candidates = [][]string{{"xdg-open", file}, {"wslview", file}}
	}
	for _, argv := range candidates {
		if goos != "windows" {
			path, ok := Which(io, argv[0])
			if !ok {
				continue
			}
			argv = append([]string{path}, argv[1:]...)
		}
		if hlStartOpener(argv) {
			return true
		}
	}
	return false
}

// HookListMain は `feedback-gate <host> hook-list [--no-open]` の入口。一覧の HTML を書き出し、ブラウザで開く。
// stdout に 1 行（開いた / 開けなかった / 書き出しただけ、とファイルのパス）を出す。終了コードは 0（書き出せなければ 1）。
func HookListMain(host Host, args []string, env map[string]string, cwd string, stdout, stderr io.Writer) int {
	options := host.Options(env)
	osIo := MakeOsIo(OsIoInit{
		Environ:        env,
		PayloadCwd:     cwd,
		Language:       options.Language,
		AutoCount:      BoolPtr(options.AutoCountEnabled()),
		AppName:        host.AppName(),
		ConfigDirNames: host.ConfigDirNames(),
	})
	path, err := writeHookList(osIo, options)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "[hook-list] internal error: %v\n", err)
		return 1
	}
	key := "hookList.written"
	if !fbContainsString(args, "--no-open") {
		key = "hookList.openFailed"
		if hlOpenInBrowser(osIo, runtime.GOOS, path) {
			key = "hookList.opened"
		}
	}
	_, _ = fmt.Fprintln(stdout, Tr(osIo.Lang())(key, map[string]any{"path": path}))
	return 0
}

// writeHookList は一覧のモデルを作って HTML に書き出し、そのパスを返す。
func writeHookList(io Io, options PluginOptions) (string, error) {
	model, err := BuildHookListModel(io, options)
	if err != nil {
		return "", err
	}
	html, err := RenderHookListHTML(model)
	if err != nil {
		return "", err
	}
	path := HookListPath(io, model.Project)
	return path, io.WriteFile(path, html)
}

// hookListCwd は作業ディレクトリ（取れなければ ""）。
func hookListCwd() string {
	cwd, _ := os.Getwd()
	return cwd
}

// HookListCli は main から呼ぶ入口（環境変数と作業ディレクトリをこのプロセスのものにする）。
func HookListCli(host Host, args []string, stdout, stderr io.Writer) int {
	return HookListMain(host, args, EnvironMap(), hookListCwd(), stdout, stderr)
}
