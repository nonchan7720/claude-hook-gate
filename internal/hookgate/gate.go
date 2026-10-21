package hookgate

// gate hook 本体（src/gate.ts の移植）。PostToolUse（rules フェーズ）と Stop / SubagentStop（checks フェーズ）の両方から
// 呼ばれ、gate.yaml の glob ルールに従って変更ファイルに対応するコマンドを実行する。
//
// 二相構造:
//   - rules フェーズ（PostToolUse、phase=rules）: マッチしたルールの run だけを実行する。ブロックしない
//     （PostToolUse の exit 2 はツール実行後の stderr フィードバックであり、会話は止まらない）。マッチした
//     ルールが run_checks で参照した consistency_checks の名前を、checks フェーズが後で実行するための
//     「予約」として永続化する。
//     失敗したファイルは FAILED（gate_failed.<state_id>.txt）に控える。
//   - checks フェーズ（Stop / SubagentStop、phase=checks、デフォルト）: FAILED に残っているファイルの rules を
//     最新の内容で再実行し、続けて予約された consistency_checks を実行する。rules が直っていない、または
//     check が失敗なら exit 2 で会話の終了をブロックし（成功報告も出さない）、MAX_ATTEMPTS で
//     打ち切る。実際に 1 件以上実行してすべて成功したときは、結果の要約を reason にして 1 回だけ
//     ブロックする（report_success: false で無効。stop_hook_active のときは報告しない）。その直後の
//     Stop は印（gate_reported）を消して、コマンドを走らせずに通す。
//
// FAILED・予約・控えがすべて空なら checks フェーズは即 exit 0（諦めたときは FAILED も消す）。run_checks を持たない
// ルールで通ったファイルは、それ以上待つものが無いので rules フェーズの時点で完了扱いになり、CHANGED
// からも SIDECAR からも外れる。以後そのファイルが別の変更で壊れても検出されない（run_checks がパッケージ
// 跨ぎ検証の唯一の手段）。
//
// 状態ファイル（CHANGED/COUNT/SIDECAR/PENDING/ログディレクトリ）の ID は、agentId があれば
// "<session_id>--<agent_id>"、無ければ session_id そのもの。changed_files の各行は実パスが
// <projectDir>/.claude/worktrees/<name>/ 配下ならそのディレクトリを「ルート」として扱い、ルートごとに cwd と
// そのルート自身の .claude/gate.yaml（無ければメインの cfg にフォールバック）で独立にチェックする。
// worktree が既に消えている場合は警告して対象から外す。予約（PENDING）もルート単位で持つ（あるルートの
// rule がマッチして予約した check を、別のルートで実行してはいけない）。
//
// rule は通ったが consistency_checks の確認待ちのファイルは changed_files から間引き
// gate_passed.<state_id>.txt (SIDECAR) へ退避する。checks フェーズで対応する consistency_checks が全て
// 成功したら SIDECAR から確定除去する。失敗し MAX_ATTEMPTS で諦めたときは、黙って確認済み扱いにはせず
// CHANGED へ戻す（次の編集で rules フェーズが再度拾えるようにするため）。
//
// gate.yaml の書式（scripts/gate.schema.json も参照）:
//
// match:       glob（文字列 or リスト）。* は / を跨がない、** は跨ぐ、{a,b} 展開可。
// dir:         コマンドを実行する作業ディレクトリ（省略時はプロジェクトルート）。
//              per_file_dir が設定されているときは無視される。
// per_file_dir: dir を無視し、match にマッチした各ファイルからルートを決めて、ルートごとに run を実行する
//              （ルート単位で重複排除、実行順はルート名の昇順）。値は true / "file" / "pattern_root" の
//              いずれか（true は "file" の別名）。
//              - "file"（true と同義）: マッチした各ファイル自身のディレクトリをルートにする。match の
//                パターン文字列（** の位置）は一切見ない。ディレクトリ＝パッケージという構成（Go の1ディレクトリ
//                1パッケージなど）向け。
//              - "pattern_root": マッチしたパターンの最初の ** セグメントの直前までに対応する実パス部分を
//                ルートにする（** を含まないパターンではファイル自身の dirname にフォールバック）。
//                ネストした階層のファイルを触っても package.json / pyproject.toml があるパッケージルートで
//                まとめて実行したい構成（pnpm workspace 等）向け。
//              上記以外の値（false・未設定を含む）は per_file_dir を使わない指定として扱われるが、
//              true/false のいずれでもない不正な文字列が指定された場合はルールをスキップした上で rules
//              フェーズを失敗扱いにする（黙って無視しない）。
// run:         マッチしたとき実行するコマンド列。1つでも非0なら失敗＝rules フェーズでは stderr 通知（会話は
//              止めない。ただし FAILED に控え、直るまで checks フェーズで再実行して停止をブロックする）、
//              checks フェーズでは停止をブロック。各要素は文字列、{cmd, name, timeout} 形式、
//              または {parallel: [...]} 形式。timeout はそのコマンドのタイムアウト秒数（省略時 300 秒）。
//              超過したら強制終了して失敗扱い。rule / consistency_check レベルの timeout: はデフォルト値になる。
//              name はログファイル名に使う識別名（省略時は cmd から生成）。share: false を書くと、他のエージェントが
//              同じキー（root・cwd・cmd・渡す環境変数。エージェント識別用の変数と CLAUDE_GATE_FILES は除く）を
//              実行中でも待たずに自分で実行する（既定は共有: 進行中の実行があれば起動せず完了を待って同じ結果を
//              受け取る。ただし進行中の実行の対象ファイルが自分の対象ファイルをすべて含むときだけ。含まないときや
//              環境変数・root・cwd が違うときも、name（無ければ cmd）が同じ実行が走っている間は起動せず、終わるのを待って
//              から実行する＝同じコマンドは直列。同じリポジトリの別の git worktree で動くエージェントの間でも直列になる
//              （ロックは ~/.claude/.gate-status/shared/<project_id>/ に置く）。shared_run.go）。
//              files: false を書くと、そのコマンドは対象ファイルを使わないものとして、共有の判定上の対象ファイルを
//              空として扱う（対象ファイルが違っても共有される）。CLAUDE_GATE_FILES 自体は従来どおり渡る。
//              share: false と併記した場合は share: false が優先される。
// CLAUDE_GATE_FILES:
//              run / consistency_checks の各コマンドには、そのとき対象になっているファイルのルート相対
//              パスが環境変数 CLAUDE_GATE_FILES で渡る。値は shlex 引用済み・重複排除・昇順で、空白区切りの
//              1行。パスに空白が無ければ `cmd $CLAUDE_GATE_FILES` で渡せる。空白を含みうるなら
//              `eval "set -- $CLAUDE_GATE_FILES"` で位置パラメータに戻して使う。
// parallel:    run の要素として {parallel: [文字列 or {cmd, timeout}, ...]} を書くと、その中のコマンドは
//              並行実行される（全て完了してから次の要素へ進む）。parallel の中に parallel はネストできない
//              （失敗扱い）。
// policy:      dogwood のポリシーファイル（.dw）のパス。トップレベルに書くと全ルール / 全
//              consistency_checks の既定値になり、rules[] / consistency_checks[] 側に書くとそのルールだけ
//              上書きする。root_dir（projectDir または worktree ルート）からの相対パス（絶対パスと ~ 展開も
//              可）。設定されている間は run の各コマンドを実行前に dogwood replay で判定し、deny なら実行せず
//              控えに積む。スキップは失敗ではない。未設定なら同梱の既定ポリシー scripts/dogwood/gate.default.dw
//              が適用される。false を書くと判定せず従来どおり毎回実行する。パスを明示したのにそのファイルが
//              存在しない場合は、既定へフォールバックせず判定を無効にしてログを出す（設定ミスを黙って
//              埋めないため）。ポリシーはあるのに replay が非0・出力が壊れている場合、そのコマンドは実行せず
//              控えに積む。dogwood が見つからない場合も同じだが、既定ポリシー（policy: を書いていない）の
//              ときだけは従来どおり実行する。
// policy_schema: policy の検証に使う Cedar スキーマ（.cedarschema）のパス。省略時は同梱の
//              scripts/dogwood/gate.cedarschema。ポリシーに渡る入力は name と cmd の2つだけ。
//
// ポリシー判定の実行履歴は ${projectDir}/.claude/.gate-status/gate_trace.{state_id}.jsonl に、スキップした
// コマンドの控えは同じ場所の gate_deferred.{state_id}.json に溜まる。控えは rules フェーズで allow された
// コマンドが1つでも実行された回に、ポリシー判定をバイパスして消化される。ただし消化されるのはその回が
// 始まる前から控えにあった分だけ。checks フェーズ（Stop / SubagentStop）では、その回が始まる前から
// あった控えを全件消化し、失敗した分は控えに戻して停止をブロックする。各プロジェクトの .gitignore には
// .claude/.gate-status/ を足すこと。
//
// 各コマンドの出力は ${projectDir}/.claude/.gate-status/logs/{state_id}/{name もしくは cmd}.{uid}.log に
// 書き出される（コマンドの完了時にまとめて。実行中の開始行だけは先に書く）。フック起動時に自動削除:
// 現セッションのログは1時間（LOG_MAX_AGE）超で、過去セッションのログは最終書き込みから5分
// （LOG_STALE_GRACE）超で消える。
// run_checks:  このルールがマッチしたとき、rules フェーズが checks フェーズへ予約する consistency_checks の
//              名前一覧。実際に実行されるのは checks フェーズで、マッチしたルールが参照した名前だけが動く。
// consistency_checks: name/dir/run を持つ名前付きチェック定義集（match は持たない）。checks フェーズでしか
//              実行されない。
//
// Go 版の注記: TS 版は Promise だが、こちらはすべて同期。parallel ブロックだけは goroutine で並行実行する。そのため
// 並行して触れる状態（status / failures / 帯の一覧）は mutex で守る。TS 版の「例外」は panic で表し、RunGate が
// recover して内部エラーとして報告する（goroutine 内の panic は呼び出し側へ持ち回して再 panic する）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf16"
)

// ---- 定数 ----

// gate の定数（TS の export const と同じ名前）。
const (
	MAX_ATTEMPTS    = 5
	DEFAULT_TIMEOUT = 300   // 秒。rule / consistency_check の timeout: で上書き可
	LOG_MAX_AGE     = 3600  // 秒。現セッションのログでもこれより古ければ削除
	LOG_STALE_GRACE = 300   // 秒。他セッションのログは最終書き込みからこれだけ経てば削除
	TRACE_WINDOW    = 86400 // 秒。dogwood の時間窓の上限（既定 24h）を超えた履歴は判定に使えない
	POLICY_TIMEOUT  = 30    // 秒。dogwood replay 自体のタイムアウト
	// FILES_ENV_KEY は run のコマンドへ「今回 match した対象ファイル」を渡す環境変数名。
	FILES_ENV_KEY = "CLAUDE_GATE_FILES"

	gatePrincipal      = `Gate::Agent::"gate"`
	gateStatusCmdMax   = 100     // 文字。1 行ログに載せるコマンドの最大長
	gateFailTailLines  = 60      // 失敗コマンド1本あたりに載せる出力の末尾行数
	gateFailDetailMax  = 12000   // 失敗詳細全体の最大文字数
	gateUnmatchedShown = 5       // どのルールにもマッチしなかったファイルを 1 行に列挙する最大数
	gateMaxTimeoutMs   = 600_000 // $.process.run の上限（10 分）
)

var gateDogwoodFallbacks = []string{"~/.cargo/bin/dogwood", "~/.local/share/mise/shims/dogwood"}

// GateEnv はコマンドへ渡す環境変数（TS の Env）。
type GateEnv = map[string]string

// RunItem は run の要素（文字列 / {cmd, name, timeout, share, files} / {parallel: [...]}）。YAML はユーザー入力なので緩く扱う。
type RunItem = any

// GateOptions は NewGate / RunGate の引数。いずれも省略可（ゼロ値が「指定なし」）:
// SessionID 空は "unknown"、AgentID 空はメインのセッション、Phase 空は checks、StopHookActive は TS の `=== true`。
type GateOptions struct {
	SessionID      string
	AgentID        string
	Phase          string
	StopHookActive bool
}

// ---- JS 互換の小物 ----

// gateTrim は JS の String.prototype.trim。
func gateTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// gateTrimEnd は JS の String.prototype.trimEnd。
func gateTrimEnd(s string) string { return strings.TrimRightFunc(s, isJSSpace) }

// gateJSLen は JS の String.length（UTF-16 の単位数）。
func gateJSLen(s string) int { return len(utf16.Encode([]rune(s))) }

// gateJSSlice は JS の s.slice(from, to)（UTF-16 の単位で、負の添字は末尾から数える）。
func gateJSSlice(s string, from, to int) string {
	u := utf16.Encode([]rune(s))
	n := len(u)
	norm := func(i int) int {
		if i < 0 {
			return max(0, n+i)
		}
		return min(i, n)
	}
	a, b := norm(from), norm(to)
	if a >= b {
		return ""
	}
	return string(utf16.Decode(u[a:b]))
}

// gateCompareJS は JS の既定の文字列比較（UTF-16 の単位順）。
func gateCompareJS(a, b string) int {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(ua) < len(ub):
		return -1
	case len(ua) > len(ub):
		return 1
	}
	return 0
}

// gateSorted は JS の [...].sort()（既定の比較）と同じ順に並べたコピー。
func gateSorted(ss []string) []string {
	out := slices.Clone(ss)
	if out == nil {
		out = []string{}
	}
	sort.SliceStable(out, func(i, j int) bool { return gateCompareJS(out[i], out[j]) < 0 })
	return out
}

// gateUniq は出現順を保った重複除去（[...new Set([...a, ...b])]）。
func gateUniq(lists ...[]string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, l := range lists {
		for _, s := range l {
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}

// gateSetOf は文字列の集合。
func gateSetOf(ss []string) map[string]bool {
	m := make(map[string]bool, len(ss))
	for _, s := range ss {
		m[s] = true
	}
	return m
}

// gateMergeMaps は後ろの値が勝つ map のマージ（new Map([...a, ...b])）。
func gateMergeMaps(maps ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// gateNumber は JS の Number(v) || 0（変換できない・NaN・0 は 0）。
func gateNumber(v any) float64 {
	f := jsNumber(v)
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// gateTplStr はテンプレートリテラルへの埋め込み（欠けていれば "undefined"）。
func gateTplStr(d Dict, key string) string {
	v, ok := d[key]
	if !ok {
		return "undefined"
	}
	return Str(v)
}

// gateTruthyStr は `v || ”` を文字列にしたもの。
func gateTruthyStr(v any) string {
	if !Truthy(v) {
		return ""
	}
	return Str(v)
}

// gateTypeErrorf は JS の TypeError に相当する panic（RunGate が内部エラーとして拾う）。
func gateTypeErrorf(format string, args ...any) {
	panic(fmt.Errorf("TypeError: "+format, args...))
}

// gateCheck は TS の `await` が拒否されて例外になる箇所。エラーなら panic する。
func gateCheck(err error) {
	if err != nil {
		panic(err)
	}
}

// gateParallelDo は n 個の処理を goroutine で並行実行して全部の完了を待つ（Promise.all 相当）。panic は先頭のものを呼び出し側へ持ち回す。
// 各処理は開始の準備ができたところで registered() を呼ぶ（呼ばずに終わっても構わない）。次の処理は前の処理が registered() を呼ぶ
// （または終わる）まで始めない＝準備の順序は定義順になる。
func gateParallelDo(n int, fn func(i int, registered func())) {
	var wg sync.WaitGroup
	panics := make([]any, n)
	for i := range n {
		ready := make(chan struct{})
		var once sync.Once
		registered := func() { once.Do(func() { close(ready) }) }
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer registered()
			defer func() {
				if r := recover(); r != nil {
					panics[i] = r
				}
			}()
			fn(i, registered)
		}()
		<-ready
	}
	wg.Wait()
	for _, p := range panics {
		if p != nil {
			panic(p)
		}
	}
}

// ---- 設定の取り出し（YAML はユーザー入力なので、実行時は緩く扱う） ----

// gateRulesOf は cfg.rules（`cfg?.rules || []`）。リストでない真値は JS では反復できず TypeError。
func gateRulesOf(cfg Dict) []any { return gateListOf(cfg, "rules") }

func gateListOf(d Dict, key string) []any {
	v := d[key]
	if !Truthy(v) {
		return nil
	}
	l, ok := v.([]any)
	if !ok {
		gateTypeErrorf("%s is not iterable", key)
	}
	return l
}

// gateDictItem は配列の要素を Dict として取り出す。null は TypeError（プロパティの参照で落ちる）、他の型は空の Dict と同じ扱い。
func gateDictItem(v any) Dict {
	if d, ok := AsDict(v); ok {
		return d
	}
	if v == nil {
		gateTypeErrorf("Cannot read properties of null")
	}
	return Dict{}
}

// gateStringList は文字列のリスト（文字列以外の要素は Str で文字列にする）。リストでなければ空。
func gateStringList(v any) []string {
	l, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, len(l))
	for i, e := range l {
		out[i] = Str(e)
	}
	return out
}

// ---- 純粋関数（glob とルート抽出） ----

// NormalizePerFileDirMode は per_file_dir の値を "file" / "pattern_root" にそろえる。不正な値は ""（TS の null）。
func NormalizePerFileDirMode(value any) string {
	if b, ok := value.(bool); ok && b {
		return "file"
	}
	switch value {
	case "file":
		return "file"
	case "pattern_root":
		return "pattern_root"
	}
	return ""
}

// FileRoot は per_file_dir: "file"（true の別名）のときの実行ルート。マッチしたファイル自身のディレクトリ。
func FileRoot(relPath string) string { return Dirname(relPath) }

var gateOnlyStarsRe = regexp.MustCompile(`^\*+$`)

// PatternRootSegmentCount は pattern を "/" で区切ったとき、最初に現れる ** 単独セグメントの位置（0始まり）。無ければ (0, false)。
func PatternRootSegmentCount(pattern string) (int, bool) {
	for i, seg := range strings.Split(pattern, "/") {
		if len(seg) >= 2 && gateOnlyStarsRe.MatchString(seg) {
			return i, true
		}
	}
	return 0, false
}

// GlobMatchRoot は per_file_dir: "pattern_root" のときの実行ルート。最初の ** セグメントの直前までのパス部分。
func GlobMatchRoot(pattern, relPath string) string {
	idx, ok := PatternRootSegmentCount(pattern)
	if !ok {
		return Dirname(relPath)
	}
	parts := strings.Split(relPath, "/")
	return strings.Join(parts[:min(idx, len(parts))], "/")
}

// ComputePerFileRoots は matched の各ファイルについて、mode に応じたルートを求める（per_file_dir のルート単位の重複排除に使う）。
func ComputePerFileRoots(mode string, patternPairs []PatternPair, matched []string) map[string]string {
	roots := map[string]string{}
	if mode == "file" {
		for _, rp := range matched {
			roots[rp] = FileRoot(rp)
		}
		return roots
	}
	for _, rp := range matched {
		for _, p := range patternPairs {
			if p.Rx.MatchString(rp) {
				roots[rp] = GlobMatchRoot(p.Text, rp)
				break
			}
		}
	}
	return roots
}

var (
	gateSlugBadRe  = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	gateSlugEdgeRe = regexp.MustCompile(`^[_.]+|[_.]+$`)
	gateNewlineRe  = regexp.MustCompile(`\r?\n`)
)

// Slug はコマンド文字列をログファイル名に使える形へ（英数と ._- 以外を _ に、80文字まで）。
func Slug(cmd string) string {
	s := gateSlugEdgeRe.ReplaceAllString(gateSlugBadRe.ReplaceAllString(cmd, "_"), "")
	if len(s) > 80 {
		s = s[:80]
	}
	if s == "" {
		return "cmd"
	}
	return s
}

// OneLine は複数行のコマンドは最初の非空行 + " ..." にし、長すぎるものは切り詰める（1 コマンド 1 行）。
func OneLine(cmd string) string {
	var lines []string
	for _, l := range gateNewlineRe.Split(cmd, -1) {
		if t := gateTrim(l); t != "" {
			lines = append(lines, t)
		}
	}
	text := ""
	if len(lines) > 0 {
		text = lines[0]
	}
	if len(lines) > 1 {
		text += " ..."
	}
	if gateJSLen(text) <= gateStatusCmdMax {
		return text
	}
	return gateJSSlice(text, 0, gateStatusCmdMax-3) + "..."
}

// FilesEnv は match したファイル（ルート相対パス）を run のコマンドへ渡す env。`for f in $CLAUDE_GATE_FILES` と単語分割して使えるよう引用する。
func FilesEnv(rels []string) GateEnv {
	sorted := gateSorted(gateUniq(rels))
	quoted := make([]string, len(sorted))
	for i, r := range sorted {
		quoted[i] = ShellQuote(r)
	}
	return GateEnv{FILES_ENV_KEY: strings.Join(quoted, " ")}
}

// MergeFilesEnv は 2つの env の CLAUDE_GATE_FILES を和集合にする（他のキーは a を優先して残す）。
func MergeFilesEnv(a, b GateEnv) GateEnv {
	var rels []string
	for _, env := range []GateEnv{a, b} {
		if v := env[FILES_ENV_KEY]; v != "" {
			split, err := ShellSplit(v)
			gateCheck(err)
			rels = append(rels, split...)
		}
	}
	out := GateEnv{}
	maps.Copy(out, b)
	maps.Copy(out, a)
	maps.Copy(out, FilesEnv(rels))
	return out
}

// CedarString は Cedar の文字列リテラルにする。
func CedarString(value any) string {
	s := Str(value)
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(s)
	return `"` + s + `"`
}

// TraceLine は実行履歴1件を dogwood のトレース行にする。判定を生むのは request だけで、response / error は履歴専用イベント。
func TraceLine(rec Dict, project string, index int) string {
	resource := "Gate::Project::" + CedarString(project)
	payload := fmt.Sprintf("{ name: %s, cmd: %s }", CedarString(gateTruthyStr(rec["name"])), CedarString(gateTruthyStr(rec["cmd"])))
	kind := gateTruthyStr(rec["kind"])
	if kind == "" {
		kind = "request"
	}
	return fmt.Sprintf("@%s scope(principal: %s, resource: %s) request_context(input: %s) ", strconv.FormatInt(int64(math.Trunc(gateNumber(rec["ts"]))), 10), gatePrincipal, resource, payload) +
		fmt.Sprintf(`Gate::Action::"Run"::%s(input: %s, callerPrincipal: %s, callerResource: %s, `, kind, payload, gatePrincipal, resource) +
		fmt.Sprintf("requestId: %s)", CedarString(fmt.Sprintf("r%d", index)))
}

// ParseCmd は run の要素（文字列 or {cmd, name, timeout}）から (コマンド文字列, タイムアウト秒, ログ名) を取り出す。ログ名が無ければ ""。
func ParseCmd(item any, defaultTimeout float64) (string, float64, string) {
	if d, ok := AsDict(item); ok {
		timeout := defaultTimeout
		if Truthy(d["timeout"]) {
			if f := jsNumber(d["timeout"]); !math.IsNaN(f) {
				timeout = f
			}
		}
		return gateTruthyStr(d["cmd"]), timeout, gateTruthyStr(d["name"])
	}
	return gateTruthyStr(item), defaultTimeout, ""
}

// ParseShare は run の要素が他のエージェントとの実行共有を許すか。{cmd, share: false} だけが無効化で、既定は共有する。
func ParseShare(item any) bool {
	d, ok := AsDict(item)
	return !ok || d["share"] != false
}

// ParseFiles は run の要素が対象ファイル（CLAUDE_GATE_FILES）を共有の判定に使うか。{cmd, files: false} だけが「使わない」で、既定は使う。
func ParseFiles(item any) bool {
	d, ok := AsDict(item)
	return !ok || d["files"] != false
}

// AgentEnv は gate がエージェントを識別するために子プロセスへ付ける環境変数。共有キーからはこれを除く（エージェントごとに必ず異なるため）。
func AgentEnv(agentID string) GateEnv {
	if agentID == "" {
		return GateEnv{}
	}
	return GateEnv{"CLAUDE_AGENT_ID": agentID}
}

var gateAgentEnvKeys = slices.Collect(maps.Keys(AgentEnv("-")))

// ShareKey は実行共有のキー。root・cwd・cmd・コマンドに渡す環境変数（エージェント識別用と対象ファイル一覧を除く）が
// すべて一致するものだけが同じ実行になる。対象ファイル一覧は ShareFiles で別に扱う。
func ShareKey(root, cwd, cmd string, env GateEnv) string {
	var keys []string
	for k := range env {
		if !slices.Contains(gateAgentEnvKeys, k) && k != FILES_ENV_KEY {
			keys = append(keys, k)
		}
	}
	keys = gateSorted(keys)
	shared := make([]any, len(keys))
	for i, k := range keys {
		shared[i] = []any{k, env[k]}
	}
	return JSONStringify([]any{root, cwd, cmd, shared})
}

// SerialKey は直列化の単位。name があれば name、無ければ cmd。同じものは、root・cwd・環境変数（フェーズなど）・対象ファイルが
// 違っても、プロジェクト（.gate-status）の中で同時に 1 本しか走らせない。重いコマンドをエージェントの数だけ同時に
// 走らせると CPU の取り合いで全員が何倍も遅くなるため。
func SerialKey(name, cmd string) string {
	if name != "" {
		return "name:" + name
	}
	return "cmd:" + cmd
}

// ShareFiles は共有の判定に使う対象ファイル一覧。files が false（対象ファイルを使わないコマンド）なら空。
func ShareFiles(env GateEnv, files bool) []string {
	if files && env[FILES_ENV_KEY] != "" {
		split, err := ShellSplit(env[FILES_ENV_KEY])
		gateCheck(err)
		return split
	}
	return []string{}
}

func gateIsParallel(item any) bool {
	d, ok := AsDict(item)
	if !ok {
		return false
	}
	_, has := d["parallel"]
	return has
}

// SummarizeCmds は run_cmds は1つ失敗しても後続を実行し続ける（&& ではなく ; 相当）ので、表示もそれに合わせる。
func SummarizeCmds(cmds []any) string {
	parts := make([]string, 0, len(cmds))
	for _, c := range cmds {
		switch {
		case gateIsParallel(c):
			d, _ := AsDict(c)
			l, _ := d["parallel"].([]any)
			parts = append(parts, "("+strings.ReplaceAll(SummarizeCmds(l), " ; ", " & ")+")")
		case IsDict(c):
			d, _ := AsDict(c)
			parts = append(parts, gateTruthyStr(d["cmd"]))
		case c == nil:
			parts = append(parts, "")
		default:
			parts = append(parts, Str(c))
		}
	}
	return strings.Join(parts, " ; ")
}

// TailOutput は出力を末尾 limit 行に切り詰める。切ったときは先頭に省略表示を付ける。
func TailOutput(lang Lang, out string, limit int) string {
	lines := gateNewlineRe.Split(gateTrimEnd(out), -1)
	if len(lines) <= limit {
		return strings.Join(lines, "\n")
	}
	head := Tr(lang)("gate.headOmitted", map[string]any{"n": len(lines) - limit})
	return strings.Join(append([]string{head}, lines[len(lines)-limit:]...), "\n")
}

// FailureDetails は失敗詳細を1つの文字列にまとめる。全体が上限を超えたら残りは省略して log を見るよう促す。
func FailureDetails(lang Lang, failures []string) string {
	if len(failures) == 0 {
		return ""
	}
	t := Tr(lang)
	var text strings.Builder
	used := 0
	omitted := 0
	for i, d := range failures {
		n := gateJSLen(d)
		if used+n+1 > gateFailDetailMax && used != 0 {
			omitted = len(failures) - i
			break
		}
		if used+n+1 > gateFailDetailMax {
			d = gateJSSlice(d, 0, gateFailDetailMax) + "\n" + t("gate.restOmitted")
			n = gateJSLen(d)
		}
		text.WriteString(d + "\n")
		used += n + 1
	}
	if omitted != 0 {
		text.WriteString(t("gate.failuresOmitted", map[string]any{"n": omitted}) + "\n")
	}
	return gateTrimEnd(text.String())
}

// ---- ファイル単位の排他（同一プロセス内。flock の代わり） ----

var (
	gateLocksMu sync.Mutex
	gateLocks   = map[string]*sync.Mutex{}
	gateLogSeq  atomic.Int64 // TS の gateLogSeq++。ログ名と dogwood のトレースファイル名の通し番号
)

// gateNextLogSeq は gateLogSeq++（加算前の値を返す）。
func gateNextLogSeq() int64 { return gateLogSeq.Add(1) - 1 }

func gateWithLock[T any](path string, fn func() T) T {
	gateLocksMu.Lock()
	mu, ok := gateLocks[path]
	if !ok {
		mu = &sync.Mutex{}
		gateLocks[path] = mu
	}
	gateLocksMu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	return fn()
}

// GateChunk は 1 コマンド分のログ行と、失敗したときの詳細。
type GateChunk struct {
	Lines  []string
	Detail string
}

// ExecScope はコマンドをどのルートで・共有を許して実行するか。Share / Files は nil が「指定なし（既定は true）」。
type ExecScope struct {
	Root  string
	Share *bool
	Files *bool
}

func (s ExecScope) shareOn() bool { return s.Share == nil || *s.Share }
func (s ExecScope) filesOn() bool { return s.Files == nil || *s.Files }

// PolicyState はフェーズ1回分の共有状態。Executed は「ポリシー判定の結果として実際に実行されたコマンドがあったか」。
type PolicyState struct {
	Executed bool
	// DeferredThisRun はこの回の中で DeferCmd() したキー。allow されて undefer された後に別ルールで再度 deny されて積み直された分を消化対象にしない。
	DeferredThisRun map[string]bool
	// AllowedThisRun はこの回の中で allow されて実行に進んだキー。checks フェーズで同じコマンドの控えを再実行しないために使う。
	AllowedThisRun map[string]bool
}

// NewPolicyState は空の PolicyState。
func NewPolicyState() *PolicyState {
	return &PolicyState{DeferredThisRun: map[string]bool{}, AllowedThisRun: map[string]bool{}}
}

// Gate は gate を 1 回実行するための状態（TS の class Gate）。
type Gate struct {
	Io Io
	// T は io.Lang() で引く翻訳関数。
	T              Translate
	ProjectDir     string
	SessionID      string
	AgentID        string
	StateID        string
	Phase          string
	StopHookActive bool
	Action         string
	StateDir       string
	Changed        string
	Count          string
	Sidecar        string
	Pending        string
	Reported       string
	Trace          string
	Deferred       string
	Failed         string
	LogRoot        string
	LogDir         string
	DefaultPolicy  string

	DefaultPolicySchema string
	// BaseEnv は実行するコマンドに渡す環境変数（元の hook スクリプトが子プロセスへ引き継いでいたもの）。
	BaseEnv GateEnv
	// Status は通過・スキップ・失敗の 1 行ログ（通ったのか実行されなかったのかを区別するため）。
	Status []string
	// Failures は失敗したコマンドだけの詳細（ヘッダ・出力末尾・タイムアウト文言・log パス）。
	Failures []string
	Stdout   string
	Stderr   string
	// ReportConsumed は成功報告の印を消費して、検証を走らせずに Stop を通したとき true。
	ReportConsumed bool
	// Report は checks フェーズの最終結果の要約（サブエージェントの結果を呼び出し元へ渡すのに使う。subagent_report.go）。
	// 報告するものが無ければ HasReport が false。
	Report    string
	HasReport bool

	mu sync.Mutex // Status / Failures / ranThisRun / executedLabels

	uiMu        sync.Mutex // running / stopTicking と、帯・ステータス行の更新の順序
	running     []*RunningEntry
	stopTicking func()
	// runningOwner は全エージェントの実行中一覧（running_registry）の中での、この Gate の持ち分の名前。
	runningOwner string
	// ranThisRun はこの Gate が実行した（または共有で結果を受け取った）コマンドの (root, cwd, cmd) キー。同じ回で控えを二重に走らせないために使う。
	ranThisRun map[string]bool
	// executedLabels はこの Gate が実際に実行した（または共有で結果を受け取った）コマンドの表示名。成功報告に使う。
	executedLabels []string
}

const gateBase36 = "0123456789abcdefghijklmnopqrstuvwxyz"

func randomOwnerSuffix() string {
	b := make([]byte, 8)
	for i := range b {
		b[i] = gateBase36[rand.IntN(len(gateBase36))] //nolint:gosec // 帯の持ち分を区別する名前で、暗号用途ではない
	}
	return string(b)
}

// NewGate は Gate を作る（Main は呼ばない）。
func NewGate(io Io, opts GateOptions) *Gate {
	projectDir := io.ProjectDir()
	if projectDir == "" {
		projectDir = io.Cwd()
	}
	sessionID := opts.SessionID
	if sessionID == "" {
		sessionID = "unknown"
	}
	stateID := sessionID
	if opts.AgentID != "" {
		stateID = sessionID + "--" + opts.AgentID
	}
	// 未指定時は checks（この hook の唯一の呼び出し元が長らく Stop だったため）。
	phase := opts.Phase
	if phase == "" {
		phase = "checks"
	}
	phase = strings.ToLower(gateTrim(phase))
	stateDir := GateStatusDir(io) // 状態ファイルとログの置き場所（gate.yaml は動かさない）
	stop := "false"
	if opts.StopHookActive {
		stop = "true"
	}
	baseEnv := GateEnv{
		"CLAUDE_PROJECT_DIR":      projectDir,
		"CLAUDE_SESSION_ID":       sessionID,
		"CLAUDE_STOP_HOOK_ACTIVE": stop,
		"CLAUDE_GATE_PHASE":       phase,
	}
	maps.Copy(baseEnv, AgentEnv(opts.AgentID))
	logRoot := Join(stateDir, "logs")
	return &Gate{
		Io:                  io,
		T:                   Tr(io.Lang()),
		ProjectDir:          projectDir,
		SessionID:           sessionID,
		AgentID:             opts.AgentID,
		StateID:             stateID,
		Phase:               phase,
		StopHookActive:      opts.StopHookActive,
		Action:              Join(io.ProjectConfigDir(), "gate.yaml"),
		StateDir:            stateDir,
		runningOwner:        stateID + "." + randomOwnerSuffix(),
		Changed:             Join(stateDir, "changed_files."+stateID+".txt"),
		Count:               Join(stateDir, "gate_attempts."+stateID+".txt"),
		Sidecar:             Join(stateDir, "gate_passed."+stateID+".txt"),          // rule通過・checks確認待ち
		Pending:             Join(stateDir, "gate_pending_checks."+stateID+".json"), // checksフェーズへの予約
		Reported:            Join(stateDir, "gate_reported."+stateID+".txt"),        // 成功報告でブロックした印
		Trace:               Join(stateDir, "gate_trace."+stateID+".jsonl"),         // ポリシー判定に食わせる実行履歴
		Deferred:            Join(stateDir, "gate_deferred."+stateID+".json"),       // ポリシーでスキップした分の控え
		Failed:              Join(stateDir, "gate_failed."+stateID+".txt"),          // rules で失敗したまま直っていないファイル
		LogRoot:             logRoot,
		LogDir:              Join(logRoot, stateID),
		DefaultPolicy:       Join(io.PluginRoot(), "scripts", "dogwood", "gate.default.dw"),
		DefaultPolicySchema: Join(io.PluginRoot(), "scripts", "dogwood", "gate.cedarschema"),
		BaseEnv:             baseEnv,
		ranThisRun:          map[string]bool{},
	}
}

func (g *Gate) print(obj any) {
	g.Stdout += JSONStringify(obj) + "\n"
}

func (g *Gate) writeErr(text string) {
	g.Stderr += text
}

func (g *Gate) setReport(text string) {
	g.Report = text
	g.HasReport = true
}

// Cleanup は状態ファイルを削除する。only が nil でなければ、その集合だけを消す。
func (g *Gate) Cleanup(only []string) {
	if only == nil {
		only = []string{g.Changed, g.Count, g.Sidecar, g.Pending, g.Reported, g.Failed}
	}
	g.Io.RemoveFiles(only)
}

func (g *Gate) rm(path string) {
	g.Io.RemoveFiles([]string{path})
}

// ---- ログ掃除 ----

func (g *Gate) pruneDir(dirpath string, maxAge int64, rmdir bool) {
	cutoff := g.Io.Now() - maxAge*1000
	var old []string
	for _, e := range g.Io.List(dirpath) {
		if strings.HasSuffix(e.Name, ".log") && e.Kind == KindFile && e.MtimeMs < cutoff {
			old = append(old, Join(dirpath, e.Name))
		}
	}
	if len(old) > 0 {
		g.Io.RemoveFiles(old)
	}
	if rmdir {
		g.Io.RemoveDir(dirpath)
	}
}

// pruneShared は受け取り手が読み終えた共有結果と、落ちたプロセスが残した実行中一覧を掃除する。
func (g *Gate) pruneShared() {
	now := g.Io.Now()
	stale := func(dir, suffix string, maxAge int64) {
		var old []string
		for _, e := range g.Io.List(dir) {
			if e.Kind == KindFile && strings.HasSuffix(e.Name, suffix) && e.MtimeMs < now-maxAge*1000 {
				old = append(old, Join(dir, e.Name))
			}
		}
		if len(old) > 0 {
			g.Io.RemoveFiles(old)
		}
	}
	stale(SharedDir(g.Io), ".result.json", LOG_STALE_GRACE)
	stale(Join(g.StateDir, "running"), ".json", LOG_MAX_AGE)
}

// PruneLogs は現セッション分は LOG_MAX_AGE、他セッション分は LOG_STALE_GRACE を超えたら削除。
func (g *Gate) PruneLogs() {
	g.pruneShared()
	for _, e := range g.Io.List(g.LogRoot) {
		path := Join(g.LogRoot, e.Name)
		switch {
		case e.Kind == KindDir:
			if e.Name == g.StateID {
				g.pruneDir(path, LOG_MAX_AGE, false)
			} else {
				g.pruneDir(path, LOG_STALE_GRACE, true)
			}
		case strings.HasSuffix(e.Name, ".log") && e.Kind == KindFile:
			// セッション別ディレクトリ導入前の直下ログも掃除
			if e.MtimeMs < g.Io.Now()-LOG_STALE_GRACE*1000 {
				g.rm(path)
			}
		}
	}
}

// ---- 通過・スキップ・失敗の 1 行ログ ----

// Note は通過・スキップ・失敗の 1 行を Status に足す。
func (g *Gate) Note(kind, label, cmd string, detail ...string) {
	d := ""
	if len(detail) > 0 {
		d = detail[0]
	}
	if d != "" {
		d = " " + d
	}
	line := fmt.Sprintf("[gate] %s: %s $ %s%s", kind, label, OneLine(cmd), d)
	g.mu.Lock()
	g.Status = append(g.Status, line)
	g.mu.Unlock()
}

// StatusBlock は Status を改行でつないだもの。空なら fallback。
func (g *Gate) StatusBlock(fallback string) string {
	if len(g.Status) > 0 {
		return strings.Join(g.Status, "\n")
	}
	return fallback
}

// ---- 実行履歴と控え（スキップ分）の永続化 ----

// gateTraceOrder は gate_trace の 1 レコードのキー順（TS の書き込み順）。
var gateTraceOrder = []string{"ts", "root", "cwd", "name", "cmd", "kind"}

// gateDeferredOrder は gate_deferred の 1 エントリのキー順。
var gateDeferredOrder = []string{"root", "cwd", "name", "cmd", "timeout", "label", "env"}

// gateOrdered は d を order の順（無いキーは飛ばす）→ 残りのキーの昇順で出力する OMap にする。
func gateOrdered(d Dict, order []string) OMap {
	var m OMap
	seen := map[string]bool{}
	for _, k := range order {
		if v, ok := d[k]; ok {
			m = append(m, KV{k, v})
			seen[k] = true
		}
	}
	var rest []string
	for k := range d {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	for _, k := range gateSorted(rest) {
		m = append(m, KV{k, d[k]})
	}
	return m
}

func (g *Gate) loadTrace() []Dict {
	text, _ := g.Io.ReadFile(g.Trace)
	records := []Dict{}
	for _, line := range strings.Split(text, "\n") {
		t := gateTrim(line)
		if t == "" {
			continue
		}
		var rec any
		if json.Unmarshal([]byte(t), &rec) != nil {
			continue // 壊れた行は読み飛ばす
		}
		if d, ok := AsDict(rec); ok {
			records = append(records, d)
		}
	}
	return records
}

// ReadTrace は実行履歴のうち root のものだけを ts 昇順で返す。
func (g *Gate) ReadTrace(root string) []Dict {
	if !g.Io.Exists(g.Trace) {
		return []Dict{}
	}
	records := gateWithLock(g.Trace, g.loadTrace)
	out := []Dict{}
	for _, r := range records {
		if r["root"] == root {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return gateNumber(out[i]["ts"]) < gateNumber(out[j]["ts"]) })
	return out
}

// AppendTrace は実行履歴を1件追記し、書き込んだ ts を返す。dogwood のトレースは時系列順である必要があるので ts は
// root 内で単調非減少にする。書き込みのたびに TRACE_WINDOW より古いレコードを間引く。
func (g *Gate) AppendTrace(root, cwd, name, cmd, kind string) float64 {
	now := math.Floor(float64(g.Io.Now()) / 1000)
	return gateWithLock(g.Trace, func() float64 {
		records := g.loadTrace()
		last := 0.0
		for _, r := range records {
			if r["root"] == root {
				last = math.Max(last, gateNumber(r["ts"]))
			}
		}
		ts := math.Max(now, last)
		records = append(records, Dict{"ts": ts, "root": root, "cwd": cwd, "name": name, "cmd": cmd, "kind": kind})
		var b strings.Builder
		for _, r := range records {
			if gateNumber(r["ts"]) >= now-TRACE_WINDOW {
				b.WriteString(JSONStringify(gateOrdered(r, gateTraceOrder)) + "\n")
			}
		}
		gateCheck(g.Io.WriteFile(g.Trace, b.String()))
		return ts
	})
}

func (g *Gate) loadDeferred() []Dict {
	text, _ := g.Io.ReadFile(g.Deferred)
	if text == "" {
		text = "[]"
	}
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		return []Dict{}
	}
	list, ok := v.([]any)
	if !ok {
		return []Dict{}
	}
	entries := []Dict{}
	for _, e := range list {
		if d, ok := AsDict(e); ok {
			entries = append(entries, d)
		}
	}
	return entries
}

func (g *Gate) dumpDeferred(entries []Dict) {
	list := make([]any, len(entries))
	for i, e := range entries {
		list[i] = gateOrdered(e, gateDeferredOrder)
	}
	gateCheck(g.Io.WriteFile(g.Deferred, JSONStringify(list)))
}

// gateEntryEnv は控えのエントリの env。
func gateEntryEnv(e Dict) GateEnv {
	d, ok := AsDict(e["env"])
	if !ok {
		return nil
	}
	env := GateEnv{}
	for k, v := range d {
		env[k] = Str(v)
	}
	return env
}

func gateEnvDict(env GateEnv) Dict {
	d := Dict{}
	for k, v := range env {
		d[k] = v
	}
	return d
}

func gateEntryIs(e Dict, key, want string) bool {
	s, ok := e[key].(string)
	return ok && s == want
}

// gateDeferKeyOf は控えのキー `${root}\0${cwd}\0${cmd}`。
func gateDeferKeyOf(root, cwd, cmd string) string { return root + "\x00" + cwd + "\x00" + cmd }

func gateDeferKey(e Dict) string {
	return gateTplStr(e, "root") + "\x00" + gateTplStr(e, "cwd") + "\x00" + gateTplStr(e, "cmd")
}

// DeferCmd はスキップしたコマンドを控えへ積む。(root, cwd, cmd) が同じものは積み直さないが、対象ファイルの env
// （CLAUDE_GATE_FILES）だけは既存の控えへマージする。控えを消化するのは後の回なので、その間に積まれた
// 別の match ファイルを取りこぼさないため。
func (g *Gate) DeferCmd(root, cwd, name, cmd string, timeout float64, label string, extraEnv GateEnv) {
	gateWithLock(g.Deferred, func() struct{} {
		entries := g.loadDeferred()
		for _, e := range entries {
			if gateEntryIs(e, "root", root) && gateEntryIs(e, "cwd", cwd) && gateEntryIs(e, "cmd", cmd) {
				cur := gateEntryEnv(e)
				merged := MergeFilesEnv(cur, extraEnv)
				if !maps.Equal(merged, cur) {
					e["env"] = gateEnvDict(merged)
					g.dumpDeferred(entries)
				}
				return struct{}{}
			}
		}
		env := Dict{}
		if extraEnv != nil {
			env = gateEnvDict(extraEnv)
		}
		entries = append(entries, Dict{"root": root, "cwd": cwd, "name": name, "cmd": cmd, "timeout": timeout, "label": label, "env": env})
		g.dumpDeferred(entries)
		return struct{}{}
	})
}

// UndeferCmd は今から実行するコマンドが控えにも残っていれば取り除く（前回 deny された分を消化と実行で二重に走らせないため）。
func (g *Gate) UndeferCmd(root, cwd, cmd string) {
	if !g.Io.Exists(g.Deferred) {
		return
	}
	gateWithLock(g.Deferred, func() struct{} {
		entries := g.loadDeferred()
		kept := []Dict{}
		for _, e := range entries {
			if !gateEntryIs(e, "root", root) || !gateEntryIs(e, "cwd", cwd) || !gateEntryIs(e, "cmd", cmd) {
				kept = append(kept, e)
			}
		}
		if len(kept) != len(entries) {
			g.dumpDeferred(kept)
		}
		return struct{}{}
	})
}

// TakeDeferred は控えを全件取り出して空にする。
func (g *Gate) TakeDeferred() []Dict {
	if !g.Io.Exists(g.Deferred) {
		return []Dict{}
	}
	return gateWithLock(g.Deferred, func() []Dict {
		entries := g.loadDeferred()
		g.dumpDeferred([]Dict{})
		return entries
	})
}

// DeferredKeys は控えの現在の内容を (root, cwd, cmd) キーの集合として返す（消化しない）。
func (g *Gate) DeferredKeys() map[string]bool {
	if !g.Io.Exists(g.Deferred) {
		return map[string]bool{}
	}
	entries := gateWithLock(g.Deferred, g.loadDeferred)
	keys := map[string]bool{}
	for _, e := range entries {
		keys[gateDeferKey(e)] = true
	}
	return keys
}

// TakeDeferredMatching は控えのうち渡されたキーに一致するものだけを取り出す。一致しなかったエントリ（この呼び出し中に新しく積まれた分）は控えに残す。
func (g *Gate) TakeDeferredMatching(keys map[string]bool) []Dict {
	if !g.Io.Exists(g.Deferred) {
		return []Dict{}
	}
	return gateWithLock(g.Deferred, func() []Dict {
		entries := g.loadDeferred()
		matched := []Dict{}
		kept := []Dict{}
		for _, e := range entries {
			if keys[gateDeferKey(e)] {
				matched = append(matched, e)
			} else {
				kept = append(kept, e)
			}
		}
		if len(matched) > 0 {
			g.dumpDeferred(kept)
		}
		return matched
	})
}

// ---- ルート（worktree）と変更ファイル一覧 ----

// mk は (root, rel) のキー。
func gateKey(root, rel string) string { return root + "\x00" + rel }

func gateUnkey(k string) (string, string) {
	root, rel, _ := strings.Cut(k, "\x00")
	return root, rel
}

// SplitRoot は changed_files の 1 行を (ルート, ルート相対パス) にする。
func (g *Gate) SplitRoot(raw string) (string, string) {
	return SplitRoot(g.ProjectDir, raw)
}

// gateChangedFlat は changed_files 形式のファイルの内容: (root, rel) キーの出現順リストと、キーごとの元表記。
type gateChangedFlat struct {
	order    []string
	rawByKey map[string]string
}

// LoadChangedFlat は path（無ければ空扱い）を読み、(root, rel) キーの出現順リストと、キーごとの元表記を返す。
func (g *Gate) loadChangedFlat(path string) gateChangedFlat {
	out := gateChangedFlat{order: []string{}, rawByKey: map[string]string{}}
	text, ok := g.Io.ReadFile(path)
	if !ok {
		return out
	}
	for _, line := range strings.Split(text, "\n") {
		raw := gateTrim(line)
		if raw == "" {
			continue
		}
		key := gateKey(g.SplitRoot(raw))
		if _, seen := out.rawByKey[key]; !seen {
			out.rawByKey[key] = raw
			out.order = append(out.order, key)
		}
	}
	return out
}

// writeChangedFlat は keys（重複除去済み前提）を raw 表記で書き出す。空なら削除する。
func (g *Gate) writeChangedFlat(path string, keys []string, rawByKey map[string]string) {
	if len(keys) == 0 {
		g.rm(path)
		return
	}
	var b strings.Builder
	for _, k := range keys {
		raw, ok := rawByKey[k]
		if !ok {
			_, raw = gateUnkey(k)
		}
		b.WriteString(raw + "\n")
	}
	gateCheck(g.Io.WriteFile(path, b.String()))
}

type gateRootGroups struct {
	order      []string
	relsByRoot map[string][]string
}

func gateGroupKeysByRoot(keys []string) gateRootGroups {
	out := gateRootGroups{order: []string{}, relsByRoot: map[string][]string{}}
	for _, k := range keys {
		root, rel := gateUnkey(k)
		if _, ok := out.relsByRoot[root]; !ok {
			out.order = append(out.order, root)
		}
		out.relsByRoot[root] = append(out.relsByRoot[root], rel)
	}
	return out
}

// loadRootCfg は root 自身の gate.yaml を読む。無ければメインの cfg にフォールバックする。
func (g *Gate) loadRootCfg(root string, mainCfg Dict) Dict {
	if path, ok := FindGateYaml(g.Io, root); ok {
		return g.LoadAction(path)
	}
	return mainCfg
}

// LoadAction は gate.yaml を読む。読めない・壊れているときは panic（内部エラーとして報告される）。空の文書や
// オブジェクトでない文書は nil（設定なし）。
func (g *Gate) LoadAction(path string) Dict {
	text, ok := g.Io.ReadFile(path)
	if !ok {
		panic(errors.New(g.T("gate.cannotReadYaml", map[string]any{"path": path})))
	}
	v, err := ParseYaml(text)
	if err != nil {
		panic(fmt.Errorf("YAMLParseError: %w", err))
	}
	d, _ := AsDict(v)
	return d
}

func gateIsDir(io Io, path string) bool {
	st, ok := io.Stat(path)
	return ok && st.Kind == KindDir
}
