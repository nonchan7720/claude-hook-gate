package hookgate

// 自セッション（メインとそのサブエージェント）の「実行中のコマンド」一覧。ステータス行は 1 行しか描けないので、
// 実行中はプロンプトの上の帯（mod 側の ui.render）に複数行で出す。各 Gate は自分の一覧を
// .gate-status/running/<owner>.json に公開し、帯は同じセッションの分をまとめて描く。
// 同じプロジェクトを開いた別セッションの分は混ぜない。hook がどのプロセスで動くかに依存しないよう、共有はファイルで行う。

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"unicode/utf16"
)

// RunningEntry は実行中の 1 コマンド。
type RunningEntry struct {
	Name string `json:"name,omitempty"`
	// Cmd はコマンド（複数行でもよい。表示時に 1 行へ畳む）。
	Cmd     string `json:"cmd"`
	Started int64  `json:"started"`
	// Result は "", "ok", "fail"。
	Result string `json:"result,omitempty"`
	// Ended は完了時刻（nil は未完了）。完了項目の所要時間をここで固定する。
	Ended *int64 `json:"ended,omitempty"`
	// Waiting は同じ実行を別のエージェントが走らせていて、その完了を待っている。
	Waiting bool `json:"waiting,omitempty"`
}

// Int64Ptr は *int64 を作る。
func Int64Ptr(v int64) *int64 { return &v }

const (
	maxRunMs = 600_000           // コマンド 1 本の最大実行時間（gate の MAX_TIMEOUT_MS と同じ）
	staleMs  = maxRunMs + 60_000 // これより古い開始時刻だけの一覧は、落ちたプロセスの残骸とみなす
)

// GateStatusDir は状態ファイルとログの置き場所（gate.yaml は動かさない）。
func GateStatusDir(io Io) string { return Join(io.ProjectConfigDir(), ".gate-status") }

func runningDir(io Io) string { return Join(GateStatusDir(io), "running") }

func ownerFile(io Io, owner string) string { return Join(runningDir(io), owner+".json") }

// PublishRunning はこの owner の実行中一覧を丸ごと書き換える。
func PublishRunning(io Io, owner string, entries []RunningEntry) error {
	if entries == nil {
		entries = []RunningEntry{}
	}
	return io.WriteFile(ownerFile(io, owner), JSONStringify(entries))
}

// WithdrawRunning はこの owner の一覧を消す。
func WithdrawRunning(io Io, owner string) {
	io.RemoveFiles([]string{ownerFile(io, owner)})
}

func numberOf(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	}
	return 0, false
}

func entryFromDict(d Dict) RunningEntry {
	var e RunningEntry
	if s, ok := d["name"].(string); ok {
		e.Name = s
	}
	if s, ok := d["cmd"].(string); ok {
		e.Cmd = s
	}
	if f, ok := numberOf(d["started"]); ok {
		e.Started = int64(f)
	}
	if s, ok := d["result"].(string); ok {
		e.Result = s
	}
	if f, ok := numberOf(d["ended"]); ok {
		e.Ended = Int64Ptr(int64(f))
	}
	if b, ok := d["waiting"].(bool); ok {
		e.Waiting = b
	}
	return e
}

// MergeRunning は各 owner のファイルの中身から、渡された全 owner の一覧を開始時刻順（owner 内の順序は保つ）に並べて返す。
// 古すぎる owner と壊れたファイルは無視する。
func MergeRunning(texts []string, now int64) []RunningEntry {
	var groups [][]RunningEntry
	for _, text := range texts {
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			continue
		}
		arr, _ := parsed.([]any)
		var entries []RunningEntry
		for _, item := range arr {
			if d, ok := AsDict(item); ok {
				entries = append(entries, entryFromDict(d))
			}
		}
		if len(entries) == 0 {
			continue
		}
		newest := entries[0].Started
		for _, e := range entries {
			newest = max(newest, e.Started)
		}
		if newest < now-staleMs {
			continue
		}
		groups = append(groups, entries)
	}
	sort.SliceStable(groups, func(i, j int) bool { return groups[i][0].Started < groups[j][0].Started })
	out := []RunningEntry{}
	for _, g := range groups {
		out = append(out, g...)
	}
	return out
}

// ownedBySession: owner 名は `<sessionId>.<乱数>` か `<sessionId>--<agentId>.<乱数>`。別の id の接頭辞になっているだけのものは含めない。
func ownedBySession(name, sessionID string) bool {
	return strings.HasPrefix(name, sessionID+".") || strings.HasPrefix(name, sessionID+"--")
}

// ListRunning はこのセッション（メインとそのサブエージェント）の実行中一覧。
func ListRunning(io Io, sessionID string) []RunningEntry {
	now := io.Now()
	var texts []string
	for _, f := range io.List(runningDir(io)) {
		if f.Kind != KindFile || !strings.HasSuffix(f.Name, ".json") || !ownedBySession(f.Name, sessionID) {
			continue
		}
		if text, ok := io.ReadFile(Join(runningDir(io), f.Name)); ok {
			texts = append(texts, text)
		}
	}
	return MergeRunning(texts, now)
}

const (
	bandLineMax = 80 // 帯の 1 項目（インデント込み）の最大長。超える分は cmd を ` ...` で切る
	bandIndent  = "  "
	ellipsis    = " ..."
)

// foldCmd: 複数行の cmd は先頭の行だけにして ` ...` を付ける。
func foldCmd(cmd string) string {
	var lines []string
	for _, l := range strings.Split(strings.ReplaceAll(cmd, "\r\n", "\n"), "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	first := ""
	if len(lines) > 0 {
		first = lines[0]
	}
	if len(lines) > 1 {
		return first + ellipsis
	}
	return first
}

// utf16Len は JS の String.length 相当。
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// cutCmd: room に収まらなければ、できるだけ語の切れ目で切って ` ...` を付ける（長さは JS と同じ UTF-16 単位）。
func cutCmd(text string, room int) string {
	u := utf16.Encode([]rune(text))
	if len(u) <= room {
		return text
	}
	limit := max(0, room-len(ellipsis))
	head := string(utf16.Decode(u[:limit]))
	if limit >= len(u) || u[limit] != ' ' {
		if space := strings.LastIndex(head, " "); space > 0 {
			head = head[:space]
		}
	}
	return strings.TrimRight(head, " \t\r\n") + ellipsis
}

func markOf(e RunningEntry) string {
	if e.Result == "ok" {
		return "✓"
	}
	return "✗"
}

func doneText(e RunningEntry, now int64) string {
	name := e.Name
	if name == "" {
		name = foldCmd(e.Cmd)
	}
	ended := now
	if e.Ended != nil {
		ended = *e.Ended
	}
	return name + " " + markOf(e) + " (" + ToFixed(float64(ended-e.Started)/1000, 1) + "s)"
}

func floorSeconds(ms int64) int64 {
	if ms < 0 {
		return 0
	}
	return ms / 1000
}

func runningLine(e RunningEntry, now int64, lang Lang) string {
	if e.Result != "" {
		return bandIndent + doneText(e, now)
	}
	seconds := floorSeconds(now - e.Started)
	head := bandIndent
	if e.Name != "" {
		head = bandIndent + e.Name + " $ "
	}
	tail := ""
	if e.Waiting {
		tail = " " + Tr(lang)("band.waiting")
	}
	tail += " (" + Str(seconds) + "s)"
	return head + cutCmd(foldCmd(e.Cmd), bandLineMax-utf16Len(head)-utf16Len(tail)) + tail
}

// RunningLines は帯に描く行: 見出し 1 行 + 1 項目 1 行。完了項目は所要時間を固定し、実行中の項目は now からの経過秒を出す。
func RunningLines(entries []RunningEntry, now int64, lang Lang) []string {
	lines := []string{Tr(lang)("band.running")}
	for _, e := range entries {
		lines = append(lines, runningLine(e, now, lang))
	}
	return lines
}

// RenderElement は帯の描画ツリー（TS の claude-code の RenderElement の必要な部分）。
type RenderElement struct {
	Type     string
	Props    map[string]any
	Children []any // 子要素（RenderElement）または文字列
}

// HasRunningBand は実行中・完了待ちの項目が 1 つでもあるか（RunningBand が出るか）。
func HasRunningBand(entries []RunningEntry) bool {
	for _, e := range entries {
		if e.Result == "" {
			return true
		}
	}
	return false
}

// RunningBand は実行中・完了待ちの項目が 1 つでもある間だけ帯の木を返す。全部終わっていれば (zero, false)（帯を譲る）。
func RunningBand(entries []RunningEntry, now int64, lang Lang) (RenderElement, bool) {
	if !HasRunningBand(entries) {
		return RenderElement{}, false
	}
	var children []any
	for _, line := range RunningLines(entries, now, lang) {
		children = append(children, RenderElement{Type: "Text", Children: []any{line}})
	}
	return RenderElement{Type: "Box", Props: map[string]any{"flexDirection": "column"}, Children: children}, true
}

// FinishedSummary はセッション内の全員の実行が終わったときの 1 行サマリ（ステータス行用）。チェック名は出さず件数だけにして、
// 長さを一定に保つ。所要秒は最初の開始から最後の完了まで（並列なので各項目の合計ではない）。未完了があるか、何も無ければ ("", false)。
func FinishedSummary(entries []RunningEntry, lang Lang) (string, bool) {
	if len(entries) == 0 {
		return "", false
	}
	for _, e := range entries {
		if e.Result == "" {
			return "", false
		}
	}
	passed := 0
	for _, e := range entries {
		if e.Result == "ok" {
			passed++
		}
	}
	failed := len(entries) - passed
	var counts []string
	if passed > 0 {
		counts = append(counts, "✓ "+Str(passed))
	}
	if failed > 0 {
		counts = append(counts, "✗ "+Str(failed))
	}
	first := int64(math.MaxInt64)
	last := int64(math.MinInt64)
	for _, e := range entries {
		first = min(first, e.Started)
		ended := e.Started
		if e.Ended != nil {
			ended = *e.Ended
		}
		last = max(last, ended)
	}
	return Tr(lang)("band.done", map[string]any{
		"counts":  strings.Join(counts, " / "),
		"seconds": ToFixed(float64(last-first)/1000, 1),
	}), true
}

// 完了サマリは gate が終わると一覧（running/）から消えるので、次の gate コマンドが走り始めるまで残すために
// セッションごとのファイルへ置く。feedback の表示など他の hook がステータス行を使ったあとに戻すのに使う。
func summaryFile(io Io, sessionID string) string {
	return Join(GateStatusDir(io), "summary."+sessionID+".txt")
}

// SaveSummary は完了サマリを保存する。
func SaveSummary(io Io, sessionID, text string) error {
	return io.WriteFile(summaryFile(io, sessionID), text)
}

// ClearSummary は完了サマリを消す。
func ClearSummary(io Io, sessionID string) {
	io.RemoveFiles([]string{summaryFile(io, sessionID)})
}

// LoadSummary は保存した完了サマリ。無い・空なら ("", false)。
func LoadSummary(io Io, sessionID string) (string, bool) {
	text, ok := io.ReadFile(summaryFile(io, sessionID))
	if !ok || text == "" {
		return "", false
	}
	return text, true
}
