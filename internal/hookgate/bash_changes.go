package hookgate

// Bash 経由で書き換えられたファイルを、変更ファイルのメモ（changed_files.<stateId>.txt）へ記録する（src/bash-changes.ts）。
// PreToolUse(Bash) で開始時刻を控え（BashStarted）、PostToolUse(Bash) で git が見ている変更・未追跡ファイルのうち
// mtime がコマンド開始以降のものだけを拾う（RecordBashChanges）。git の履歴・作業ツリー操作（rebase / checkout など）で
// 動いたファイルは「変更」ではないので、そのコマンドは最初から記録対象外にする。
// 見る作業ツリーは cwd のものと <projectDir>/.claude/worktrees/ 配下の worktree のうちコマンドに出てくるもので、同じコマンドの中で
// コミットされたファイルもコミット履歴から拾う（bashScanRoots / bashCandidates）。
// 拾ったファイルは feedback の post_edit / pre_edit でも検査する（feedback_bash_edit.go）。Edit / Write を使わず
// heredoc・python・sed -i などで書いても検査が抜けないようにするため。
//
// gate.yaml を持つ PJ（オプトイン）では、開始時刻を .claude/.gate-status/ に置き、拾ったファイルを変更ファイルのメモにも
// 記録して gate の rules フェーズを走らせる。gate.yaml の無い PJ では、post_edit / pre_edit の enforce を持つ有効な
// feedback ルールがあるときだけ追跡し、開始時刻は feedback 側の状態置き場（<feedbackDir>/.bash_started/。
// .ask_state と同じ流儀）に置く。gate を使っていない PJ の作業ツリーに状態ファイルを作らない（.gitignore されて
// いないので、`git add -A` で巻き込まれる）ため。メモ（changed_files）も書かない（gate の無い PJ の stop_check は
// git でフォールバックする）。
//
// 開始時刻のファイル（bash_started.<session>--<tool_use_id>.json）は tool_use_id で引く。エンジンが classic.PreToolUse
// に渡すイベントにはエージェント ID が入らない（tool.call の入力に tool / tool_use_id を足した形で、agentId は落とされる）
// 一方、classic.PostToolUse は stdin JSON そのままで agent_id を持つ。状態 ID（<session>[--<agent>]）で引くと
// サブエージェントの中では両者が食い違って開始時刻が見つからず、Bash の変更が一切記録されなかった。tool_use_id は
// 両方のイベントに同じ値で入るので、これを鍵にする。変更の記録先（changed_files）は PostToolUse 側の状態 ID で決める。
//
// TS 版は型 BashChanges と関数 bashChanges が同名で共存するが、Go では 1 つの識別子にできないので、型は BashChangeResult、
// 関数は BashChanges（BashChangeSteps を 1 つの結果にまとめるもの）とする。

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// SkipCommandRe は記録しない git コマンド（履歴・作業ツリーを動かす操作）。サブコマンドの位置（git と、-C <dir> / -c <k=v> /
// --xxx などのグローバルオプションの直後）だけを見る。`git commit -m "fix checkout"` のようにメッセージや
// 引数に語が入っただけのコマンドまで記録対象外にしないため。
var SkipCommandRe = regexp.MustCompile(
	`\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+(rebase|checkout|switch|merge|pull|stash|reset|cherry-pick|revert|restore|clean|am|apply|worktree)\b`)

// HFS+ の 1 秒粒度と時計ずれの余裕。
const bashMtimeSlackMs int64 = 2000

// コマンドが失敗すると PostToolUse は来ない（PostToolUseFailure になる）ので、開始時刻のファイルが残る。
// 次の Bash の開始時に、同じセッションの古いものを掃く。Bash ツールの最長（バックグラウンド 2h）より古ければ実行中ではない。
const bashStaleStartedMs int64 = 2 * 60 * 60 * 1000

const bashStateDir = ".gate-status"

func bashStateIDOf(payload Dict) string {
	sessionID := JqStr(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	if agentID := JqStr(payload["agent_id"]); agentID != "" {
		return sessionID + "--" + agentID
	}
	return sessionID
}

// bashSanitizeToolUseID は [^A-Za-z0-9_.-] を _ に置き換える。JS の正規表現は UTF-16 のコード単位ごとに置き換えるので、
// BMP 外の文字は _ が 2 つになる。
func bashSanitizeToolUseID(s string) string {
	var b strings.Builder
	for _, r := range s {
		if bashNameChar(r) {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
		if r > 0xFFFF {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// bashStartedKey は開始時刻ファイルの鍵。tool_use_id があれば <session>--<tool_use_id>、無ければ従来どおり状態 ID。
func bashStartedKey(payload Dict) string {
	toolUseID := bashSanitizeToolUseID(JqStr(payload["tool_use_id"]))
	if toolUseID == "" {
		return bashStateIDOf(payload)
	}
	sessionID := JqStr(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	return sessionID + "--" + toolUseID
}

func bashHasGate(io Io, projectDir string) bool {
	_, ok := FindGateYaml(io, projectDir)
	return ok
}

// BashStartedDir は開始時刻ファイルを置くディレクトリ。gate.yaml があれば <設定ディレクトリ>/.gate-status/、無ければ <feedbackDir>/.bash_started/。
func BashStartedDir(io Io, _ string, gate bool) string {
	if gate {
		return GateStatusDir(io)
	}
	return Join(FeedbackDir(io), ".bash_started")
}

func bashStartedPath(dir string, payload Dict) string {
	return Join(dir, "bash_started."+bashStartedKey(payload)+".json")
}

// bashProjectDir は io.projectDir || io.cwd。
func bashProjectDir(io Io) string {
	if d := io.ProjectDir(); d != "" {
		return d
	}
	return io.Cwd()
}

// BashStarted は PreToolUse(Bash): コマンド開始時刻を控える（追跡する必要のある PJ だけ）。常に Ok を返す。
func BashStarted(io Io, payload Dict) ScriptResult {
	func() {
		// 追跡の失敗で作業を止めない。
		defer func() { _ = recover() }()
		projectDir := bashProjectDir(io)
		gate := bashHasGate(io, projectDir)
		if !gate {
			rules, err := ListRules(io)
			if err != nil || !WantsBashEdits(rules) {
				return
			}
		}
		dir := BashStartedDir(io, projectDir, gate)
		started := io.Now()
		body := JSONStringify(OMap{{"tool_use_id", JqStr(payload["tool_use_id"])}, {"started", started}}) + "\n"
		if err := io.WriteFile(bashStartedPath(dir, payload), body); err != nil {
			return
		}
		sessionID := JqStr(payload["session_id"])
		if sessionID == "" {
			sessionID = "unknown"
		}
		bashSweepStale(io, dir, sessionID, started)
	}()
	return Ok("", "")
}

// bashSweepStale は同じセッションの bash_started.<session>--*.json のうち、bashStaleStartedMs より古いものを消す。
func bashSweepStale(io Io, stateDir, sessionID string, now int64) {
	prefix := "bash_started." + sessionID + "--"
	var stale []string
	for _, e := range io.List(stateDir) {
		if e.Kind == KindFile && strings.HasPrefix(e.Name, prefix) && strings.HasSuffix(e.Name, ".json") && e.MtimeMs < now-bashStaleStartedMs {
			stale = append(stale, Join(stateDir, e.Name))
		}
	}
	if len(stale) > 0 {
		io.RemoveFiles(stale)
	}
}

// BashChangeResult は Bash が書き換えたファイル。Changed はこのコマンドが書き換えた全ファイル（絶対パス、feedback の検査対象）、
// Recorded はそのうち変更ファイルのメモに新たに記録したもの（gate.yaml がある PJ だけ。rules フェーズの要否に使う）。
// Threshold は書き換えを判定した mtime の下限（ミリ秒）。
type BashChangeResult struct {
	Changed   []string
	Recorded  []string
	Threshold int64
	Gate      bool
}

var bashNone = BashChangeResult{Changed: []string{}, Recorded: []string{}}

// DetectBashChanges は PostToolUse(Bash): このコマンドが書き換えたファイルを拾い、gate.yaml があれば変更ファイルのメモに記録する。
func DetectBashChanges(io Io, payload Dict) BashChangeResult {
	result := bashNone
	func() {
		// TS 版の try / catch: 例外は握りつぶして NONE にする。
		defer func() {
			if r := recover(); r != nil {
				result = bashNone
			}
		}()
		result = detectBashChanges(io, payload)
	}()
	return result
}

func detectBashChanges(io Io, payload Dict) BashChangeResult {
	projectDir := bashProjectDir(io)
	gate := bashHasGate(io, projectDir)
	dir := BashStartedDir(io, projectDir, gate)
	startedFile := bashStartedPath(dir, payload)
	raw, ok := io.ReadFile(startedFile)
	if !ok {
		return bashNone
	}
	defer io.RemoveFiles([]string{startedFile})
	return bashDetect(io, projectDir, gate, dir, raw, payload)
}

// RecordBashChanges は PostToolUse(Bash): このコマンドが書き換えたファイルを記録し、新たに記録した絶対パスを返す（gate.yaml が無ければ常に空）。
func RecordBashChanges(io Io, payload Dict) []string {
	return DetectBashChanges(io, payload).Recorded
}

func bashDetect(io Io, projectDir string, gate bool, startedDirPath, raw string, payload Dict) BashChangeResult {
	var saved any
	if err := json.Unmarshal([]byte(raw), &saved); err != nil {
		return bashNone
	}
	savedDict, ok := AsDict(saved)
	if !ok {
		return bashNone
	}
	started, ok := savedDict["started"].(float64)
	if !ok {
		return bashNone
	}
	// tool_use_id が食い違う開始時刻は、別のコマンドのものなので使わない。
	if JqStr(savedDict["tool_use_id"]) != JqStr(payload["tool_use_id"]) {
		return bashNone
	}

	var command string
	if input, isDict := AsDict(payload["tool_input"]); isDict {
		command = JqStr(input["command"])
	}
	if SkipCommandRe.MatchString(command) {
		return bashNone
	}

	threshold := int64(started) - bashMtimeSlackMs
	stateDir := GateStatusDir(io)
	cwd := JqStr(payload["cwd"])
	if cwd == "" {
		cwd = io.Cwd()
	}
	changed := []string{}
	seen := map[string]bool{}
	for _, root := range bashScanRoots(io, projectDir, cwd, command) {
		for _, rel := range bashCandidates(io, root, threshold) {
			abs := Join(root, rel)
			if strings.HasPrefix(abs, stateDir+"/") || strings.HasPrefix(abs, startedDirPath+"/") || strings.HasPrefix(rel, ".claude/"+bashStateDir+"/") {
				continue
			}
			if st, ok := io.Stat(abs); ok && st.Kind == KindFile && st.MtimeMs >= threshold && !seen[abs] {
				seen[abs] = true
				changed = append(changed, abs)
			}
		}
	}
	if len(changed) == 0 || !gate {
		return BashChangeResult{Changed: changed, Recorded: []string{}, Threshold: threshold, Gate: gate}
	}

	memo := Join(stateDir, "changed_files."+bashStateIDOf(payload)+".txt")
	existing, _ := io.ReadFile(memo)
	have := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		have[line] = true
	}
	recorded := []string{}
	for _, p := range changed {
		if !have[p] {
			recorded = append(recorded, p)
		}
	}
	if len(recorded) > 0 {
		var b strings.Builder
		b.WriteString(existing)
		for _, p := range recorded {
			b.WriteString(p + "\n")
		}
		if err := io.WriteFile(memo, b.String()); err != nil {
			// TS 版は例外が DetectBashChanges 相当の catch まで抜けて NONE になる。
			return bashNone
		}
	}
	return BashChangeResult{Changed: changed, Recorded: recorded, Threshold: threshold, Gate: gate}
}

func bashGitTop(io Io, dir string) string {
	top := io.Run([]string{"git", "-C", dir, "rev-parse", "--show-toplevel"}, RunOptions{TimeoutMs: 10_000})
	if top.ExitCode == 0 {
		return strings.TrimRight(top.Stdout, "\n")
	}
	return ""
}

// MentionsWorktree は command が worktree <name> を指しているか（`.claude/worktrees/<name>` を含み、その後に名前が続かない）。
func MentionsWorktree(command, name string) bool {
	needle := "worktrees/" + name
	for from := 0; from <= len(command); {
		idx := strings.Index(command[from:], needle)
		if idx < 0 {
			break
		}
		i := from + idx
		end := i + len(needle)
		if end >= len(command) || !bashNameChar(rune(command[end])) {
			return true
		}
		from = i + 1
	}
	return false
}

// bashNameChar は [A-Za-z0-9._-]。
func bashNameChar(c rune) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
}

// bashScanRoots は変更を探す git の作業ツリー: cwd の作業ツリーと、<projectDir>/.claude/worktrees/ 直下の worktree のうちコマンドに
// パスが出てくるもの。worktree は .git を持つ入れ子の作業ツリーなので、外側から ls-files しても "<name>/" の 1 行に
// しかならない。cwd が本体のまま worktree のファイルを書き換えるコマンド（絶対パスへの heredoc など）を拾うため、個別に見る。
// コマンドに出てこない worktree は見ない。別のセッション（やエージェント）がその worktree で編集中だと、このコマンドの
// 間に書かれたファイルとして拾ってしまい、他人の書きかけ（Red のテストなど）で自分の gate が落ちるため。
func bashScanRoots(io Io, projectDir, cwd, command string) []string {
	roots := []string{}
	add := func(top string) {
		if top == "" {
			return
		}
		for _, r := range roots {
			if r == top {
				return
			}
		}
		roots = append(roots, top)
	}
	add(bashGitTop(io, cwd))
	worktreesDir := Join(projectDir, ".claude", "worktrees")
	for _, e := range io.List(worktreesDir) {
		if e.Kind == KindDir && MentionsWorktree(command, e.Name) {
			add(bashGitTop(io, Join(worktreesDir, e.Name)))
		}
	}
	return roots
}

// bashFloorSeconds は Math.floor(ms / 1000)。
func bashFloorSeconds(ms int64) int64 { return int64(math.Floor(float64(ms) / 1000)) }

// bashCandidates は root で変更の候補になるルート相対パス: 変更・未追跡のファイルと、threshold 以降のコミットが触ったファイル。
// 書いてそのまま同じコマンドで git commit すると作業ツリーには何も残らないので、コミット側も見る。
// どちらも最後に mtime で絞るので、他の作業のコミットが混ざっても、このコマンドの間に書かれていなければ落ちる。
func bashCandidates(io Io, root string, threshold int64) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	listed := io.Run([]string{"git", "-C", root, "ls-files", "-z", "--modified", "--others", "--exclude-standard", "--full-name"}, RunOptions{TimeoutMs: 10_000})
	if listed.ExitCode == 0 {
		for _, s := range strings.Split(listed.Stdout, "\x00") {
			if s != "" && !strings.HasSuffix(s, "/") {
				add(s)
			}
		}
	}
	since := "--since=@" + strconv.FormatInt(bashFloorSeconds(threshold), 10)
	logged := io.Run([]string{"git", "-C", root, "log", since, "--no-merges", "--name-only", "-z", "--format=", "HEAD"}, RunOptions{TimeoutMs: 10_000})
	if logged.ExitCode == 0 {
		for _, s := range strings.FieldsFunc(logged.Stdout, func(r rune) bool { return r == 0 || r == '\n' }) {
			add(s)
		}
	}
	return out
}

// BashChangeSteps は PostToolUse(Bash) の各段。hooks.go はこれを順に実行し、結果（block / warn）をまとめる:
// 書き換えたファイルを拾う → それぞれを feedback の post_edit / pre_edit で検査する → メモに記録できたときだけ
// gate の rules フェーズを走らせる。Edit / Write の PostToolUse（RecordChanges → FeedbackPostEdit → rules）と同じ並び。
func BashChangeSteps(payload Dict) []Step {
	found := bashNone
	return []Step{
		func(io Io) ScriptResult {
			found = DetectBashChanges(io, payload)
			return Ok("", "")
		},
		func(io Io) ScriptResult {
			if len(found.Changed) > 0 {
				return FeedbackBashEdits(io, payload, found.Changed, found.Threshold)
			}
			return Ok("", "")
		},
		func(io Io) ScriptResult {
			if len(found.Recorded) > 0 {
				return StopTestGate(io, "rules", payload)
			}
			return Ok("", "")
		},
	}
}

// BashChanges は PostToolUse(Bash): BashChangeSteps を 1 つの結果にまとめて返す（テスト・単体呼び出し用。block は先のものが勝つ）。
func BashChanges(io Io, payload Dict) ScriptResult {
	var stdout, stderr string
	exitCode := 0
	for _, step := range BashChangeSteps(payload) {
		r := step(io)
		stderr += r.Stderr
		if exitCode == 0 && r.ExitCode != 0 {
			exitCode = r.ExitCode
		}
		if fbJsTrim(stdout) == "" && fbJsTrim(r.Stdout) != "" {
			stdout = r.Stdout
		}
	}
	return ScriptResult{ExitCode: exitCode, Stdout: stdout, Stderr: stderr}
}
