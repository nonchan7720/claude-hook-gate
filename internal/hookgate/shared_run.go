package hookgate

// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// 共有ディレクトリ（下記 SharedDir）配下のファイルで調停する:
//   - <キーのハッシュ>.<ファイル一覧のハッシュ>.run/   ロックディレクトリ。`mkdir` して中に .owner を作れた側（mkdirAtomic）が
//     実行側（先着 1 名）になる。中の info.json にキー・ファイル一覧・開始時刻・タイムアウトを書く。
//   - <同じ名前>.result.json  実行側が完了時、ロックを外す前に書く結果（キーとファイル一覧付き）。
//
// 共有の単位はキー（root・cwd・cmd など）で、各実行は対象ファイル一覧を別に持つ。同じキーのロックが複数並び得る。
// 後から来た側は、同じキーで実行中のロックのうち実行側のファイル一覧が自分の一覧を含むもの（空の一覧はどれにも
// 含まれる）があれば、新たに起動せずロックが消えるまで待って結果を受け取る。無ければ自分で実行する。
// 完了済みの結果は再利用しない（次に同じキーが来たら実行し直す）。ロックは「開始時刻 + タイムアウト + 猶予」を
// 過ぎたら実行側が落ちたとみなして奪い直す。
//
// 加えて、直列化の単位（serial。gate では name、無ければ cmd）ごとに 1 本しか走らせない:
//   - <serial のハッシュ>.serial/   実行側が実行の間だけ持つ排他ロック（中に info.json）。
//
// ロックの生死はコマンドのプロセスで判定する。実行側はコマンドを走らせるシェルの PID を両方のロックの pid に書き、
// 待つ側は kill -0 で生きているかを見る。ESC などで hook が止められてロックが外れなくても、コマンドが終わって
// いれば次の側がすぐ奪い直せる（コマンドが走り続けているなら CPU を使っているので、終わるまで待つ）。PID が
// 書かれる前（info から graceMs 以内）は生きているとみなし、それを過ぎても PID が無いロックは死んでいるとみなす。
// コマンドが終わってから実行側が結果を書いてロックを外すまでにも隙間があるので、PID が死んでいてもすぐには奪わず、
// deadGraceMs だけロックが消えるのを待つ（消えたら正常に終わった実行として扱い、結果を受け取る）。
// 結果を受け取れない（ファイル一覧を含まない・環境変数が違う）同じコマンドが走っているときも、並行して起動せず、
// それが終わるのを待ってから、改めて受け取れる実行を探すか自分で実行する。重いコマンド（go test ./... など）を
// エージェントの数だけ同時に走らせないため。
//
// 待つ側が多いときに順に 1 本ずつ走らせないよう、待っている側の対象ファイル一覧はまとめる（batching）:
//   - <serial のハッシュ>.queue/<ShareID>.json   待つ側が置くキーと対象ファイル一覧。次に実行側になった者が同じキーの分を
//     自分の一覧に足して（和集合で）走らせ、置かれた分を消す。待っていた側はその実行に含まれるので結果を受け取る。
//
// さらに、違うコマンドの同時実行数にも上限を置く（max_parallel。gate.yaml のトップレベル、既定 2）:
//   - slot.<i>/   同時実行枠（i は 0 から枠数 - 1）。実行側になる者（と共有しない実行）は枠を 1 つ取ってから走らせ、
//     終わったら消す。中の info.json と pid でロックと同じように生死を判定する。受け取るだけなら枠は要らない。
//
// これらのファイルは同じリポジトリのすべての git worktree で共通の場所（~/.claude/.gate-status/shared/<project_id>/。
// SharedDir）に置く。サブエージェントが別の worktree で動いても、直列化（serial）は worktree をまたいで効く。
// キーには root・cwd が入るので、worktree が違えば結果は共有されない（別のコードを見ているため）。

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
)

// SharedOutcome は共有される実行結果。
type SharedOutcome struct {
	Out      string `json:"out"`
	Ok       bool   `json:"ok"`
	TimedOut bool   `json:"timedOut"`
	Logpath  string `json:"logpath"`
}

const (
	graceMs     = 5000    // 実行側が info.json を書くまでの隙間と、タイムアウト処理の余裕
	maxWaitMs   = 600_000 // 1 回の待機の上限
	maxRounds   = 20      // 実行側の失敗が続いても待ち続けない。超えたら共有せず自分で実行する
	pollSeconds = "0.05"
	deadGraceMs = 1500 // コマンドの終了から、実行側が結果を書いてロックを外すまでの猶予
)

// HashKey はキー文字列をファイル名に使える短い 16 進にする（cyrb53）。衝突は結果の取り違えにならないよう、キー自体を結果に持たせて確かめる。
func HashKey(key string) string {
	var h1 uint32 = 0xdeadbeef
	var h2 uint32 = 0x41c6ce57
	for _, c := range utf16.Encode([]rune(key)) {
		h1 = (h1 ^ uint32(c)) * 2654435761
		h2 = (h2 ^ uint32(c)) * 1597334677
	}
	h1 = ((h1 ^ (h1 >> 16)) * 2246822507) ^ ((h2 ^ (h2 >> 13)) * 3266489909)
	h2 = ((h2 ^ (h2 >> 16)) * 2246822507) ^ ((h1 ^ (h1 >> 13)) * 3266489909)
	return fmt.Sprintf("%014x", uint64(h2&2097151)<<32+uint64(h1))
}

var (
	sharedDirMu    sync.Mutex
	sharedDirCache = map[string]string{}
	labelCleanRe   = regexp.MustCompile(`[^A-Za-z0-9._-]`)
	pidRe          = regexp.MustCompile(`^\d+$`)
)

// SharedDir は共有・直列化のロックと結果の置き場所: ~/.claude/.gate-status/shared/<project_id>/。project_id は
// `git rev-parse --git-common-dir` の絶対パス（同じリポジトリならどの worktree からでも同じ）から作る
// `<名前>-<ハッシュ>`。git でない・失敗したときは projectDir の絶対パスから作る。HOME が無ければ従来どおり
// GateStatusDir(io)/shared。git の呼び出しを毎回しないよう、プロセス内でキャッシュする。
func SharedDir(io Io) string {
	base := io.ProjectDir()
	if base == "" {
		base = io.Cwd()
	}
	home := io.Env().Home
	cacheKey := JSONStringify([]string{home, base})
	sharedDirMu.Lock()
	defer sharedDirMu.Unlock()
	if v, ok := sharedDirCache[cacheKey]; ok {
		return v
	}
	dir := computeSharedDir(io, base, home)
	sharedDirCache[cacheKey] = dir
	return dir
}

// computeSharedDir は SharedDir の本体（キャッシュ無し）。
func computeSharedDir(io Io, base, home string) string {
	if home == "" {
		return Join(GateStatusDir(io), "shared")
	}
	ask := func(args ...string) (string, bool) {
		argv := append([]string{"git", "-C", base, "rev-parse"}, args...)
		argv = append(argv, "--git-common-dir")
		r := io.Run(argv, RunOptions{TimeoutMs: 10_000})
		out := strings.TrimSpace(r.Stdout)
		if r.ExitCode == 0 && out != "" && !strings.Contains(out, "\n") {
			return out, true
		}
		return "", false
	}
	// 古い git は --path-format を知らない。そのときは相対パスを projectDir 基準で解決する
	common, ok := ask("--path-format=absolute")
	if !ok {
		common, ok = ask()
	}
	anchor := Normpath(base)
	if ok {
		if IsAbsolute(common) {
			anchor = Normpath(common)
		} else {
			anchor = Normpath(Join(base, common))
		}
	}
	label := Basename(anchor)
	if ok && Basename(anchor) == ".git" {
		label = Basename(Dirname(anchor))
	}
	label = labelCleanRe.ReplaceAllString(label, "_")
	if label == "" {
		label = "project"
	}
	return Join(io.HomeConfigDir(), ".gate-status", "shared", label+"-"+HashKey(anchor))
}

// SharedHooks は RunShared の任意の指定。Serial は直列化の単位（省略時は key）。OnWait は待機側になったとき（最初の 1 回）に呼ばれる。
// MaxParallel は同時実行枠の数（0 以下は無制限）。実行側になるとき（と共有しない実行）はこの枠を 1 つ取ってから走らせる。
type SharedHooks struct {
	OnWait      func()
	Serial      string
	MaxParallel int
}

// SharedExecute は実行側になったときに呼ばれる。pidFiles はロックの pid ファイル（コマンドを走らせるシェルの PID を書かせる）、
// files はこの実行が対象にするファイル一覧（待っている側の分をまとめた和集合。対象ファイルを使わない実行では空）。
type SharedExecute func(pidFiles []string, files []string) SharedOutcome

// SharedResult は RunShared の結果。Shared は「他の側の結果を受け取った」こと。
type SharedResult struct {
	Outcome SharedOutcome
	Shared  bool
}

func normalizeFiles(files []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, f := range files {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

// ShareID はロック・結果ファイルの名前の元になる、キーとファイル一覧の組のハッシュ。
func ShareID(key string, files []string) string {
	return HashKey(key) + "." + HashKey(JSONStringify(normalizeFiles(files)))
}

type lockInfo struct {
	started    int64
	hasStarted bool
	limit      int64
	key        string
	hasKey     bool
	files      []string // nil は無し（空のリストは非 nil）
}

// jsNumber は JS の Number(v) 相当（変換できなければ NaN）。
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		t := strings.TrimSpace(x)
		if t == "" {
			return 0
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// sharedRun は RunShared 1 回分の状態。
type sharedRun struct {
	io         Io
	key        string
	mine       []string
	timeoutMs  int64
	execute    SharedExecute
	hooks      SharedHooks
	dir        string
	keyPrefix  string
	ownLock    string
	serialLock string
	// queueDir は同じ直列化の単位を待つ側が対象ファイル一覧を置く場所、request はその中の自分の分（出していなければ ""）。
	queueDir  string
	request   string
	announced bool
}

func resultOf(lock string) string { return strings.TrimSuffix(lock, ".run") + ".result.json" }

// mkdirAtomic は path を作れた側（ロックの持ち主）にだけ true。
//
// mkdir(1) が原子的でない実装（Ubuntu 26.04 の coreutils は uutils で、存在を確かめてから作るので、同時に呼ぶと複数が
// 0 で終わる。uutils/coreutils#13970）でも持ち主が 1 人に決まるよう、作った直後に noclobber（set -C。O_EXCL）で
// .owner を作れた側だけを持ち主とする。シェルの組み込みなので coreutils に依らない。負けた側は mkdir が「成功」して
// いてもディレクトリは持ち主のものなので、普通に「既にある」のと同じ扱い（false）になる。
func mkdirAtomic(io Io, dir, path string) bool {
	script := `mkdir -p "$1" && mkdir "$2" && (set -C && : > "$2/.owner") 2>/dev/null`
	return io.Run([]string{"sh", "-c", script, "sh", dir, path}, RunOptions{}).ExitCode == 0
}

func (r *sharedRun) mkdirAtomic(path string) bool { return mkdirAtomic(r.io, r.dir, path) }

// lead は排他ロック（と同時実行枠）を持った状態で実行し、結果を書いてから全部のロックを外す。
func (r *sharedRun) lead(slot string) SharedOutcome {
	io := r.io
	resultFile := resultOf(r.ownLock)
	defer releaseSlot(io, slot)
	defer io.RemoveTree(r.serialLock)
	started := io.Now()
	// 実行のロックの info を先に書く。排他ロックの info が見えた時点で、待つ側が受け取れる実行かを判定できるように。
	_ = io.WriteFile(Join(r.ownLock, "info.json"), JSONStringify(OMap{{"started", started}, {"timeoutMs", r.timeoutMs}, {"key", r.key}, {"files", r.mine}}))
	_ = io.WriteFile(Join(r.serialLock, "info.json"), JSONStringify(OMap{{"started", started}, {"timeoutMs", r.timeoutMs}}))
	io.RemoveFiles([]string{resultFile})
	defer io.RemoveTree(r.ownLock)
	pidFiles := []string{Join(r.serialLock, "pid"), Join(r.ownLock, "pid")}
	if slot != "" {
		pidFiles = append(pidFiles, Join(slot, "pid"))
	}
	outcome := r.execute(pidFiles, r.mine)
	_ = io.WriteFile(resultFile, JSONStringify(OMap{
		{"key", r.key}, {"files", r.mine}, {"out", outcome.Out}, {"ok", outcome.Ok}, {"timedOut", outcome.TimedOut}, {"logpath", outcome.Logpath},
	}))
	return outcome
}

// ---- 待っている側の対象ファイルをまとめる（batching） ----
//
// 受け取れない（対象ファイルを含まない）同じ直列化の単位の実行を待つ側は、自分のキーと対象ファイル一覧を
// <serial のハッシュ>.queue/<ShareID>.json に置く。次に実行側になった者は、同じキーの分を自分の一覧に足して
// （和集合で）走らせ、置かれた分を消す。待っていた側は、その実行が自分の一覧を含むので受け取れる。
// 同じコマンドをエージェントの数だけ順に走らせる代わりに、溜まった分を 1 回で済ませるため。
// 置いた分は RunShared を抜けるときに自分で消す（実行側に消されていればそれでよい）。

const requestStaleMs = maxWaitMs + graceMs // これより古い置き分は、落ちた待ち側の残骸とみなす

// postRequest は自分の対象ファイル一覧を queue に置く（1 回だけ。一覧が空なら置かない: 空の一覧は何にでも含まれる）。
func (r *sharedRun) postRequest() {
	if r.request != "" || len(r.mine) == 0 {
		return
	}
	r.request = Join(r.queueDir, ShareID(r.key, r.mine)+".json")
	_ = r.io.WriteFile(r.request, JSONStringify(OMap{{"started", r.io.Now()}, {"key", r.key}, {"files", r.mine}}))
}

func (r *sharedRun) withdrawRequest() {
	if r.request != "" {
		r.io.RemoveFiles([]string{r.request})
		r.request = ""
	}
}

// absorbRequests は queue に置かれた同じキーの一覧を自分の一覧に足し、置かれた分を消す。排他ロックを取った直後、
// 実行のロックを作る前に呼ぶ（一覧が変わると実行のロックの名前も変わる）。自分の一覧が空なら何もしない。
func (r *sharedRun) absorbRequests() {
	if len(r.mine) == 0 {
		return
	}
	now := r.io.Now()
	union := append([]string{}, r.mine...)
	var consumed []string
	for _, e := range r.io.List(r.queueDir) {
		if e.Kind != KindFile || !strings.HasSuffix(e.Name, ".json") {
			continue
		}
		path := Join(r.queueDir, e.Name)
		text, ok := r.io.ReadFile(path)
		if !ok {
			continue
		}
		var v any
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			continue
		}
		d, ok := AsDict(v)
		if !ok {
			continue
		}
		if s := jsNumber(d["started"]); finite(s) && int64(s) < now-requestStaleMs {
			consumed = append(consumed, path)
			continue
		}
		arr, ok := d["files"].([]any)
		if d["key"] != r.key || !ok {
			continue
		}
		for _, f := range arr {
			union = append(union, Str(f))
		}
		consumed = append(consumed, path)
	}
	if len(consumed) > 0 {
		r.io.RemoveFiles(consumed)
	}
	r.mine = normalizeFiles(union)
	r.ownLock = Join(r.dir, ShareID(r.key, r.mine)+".run")
}

// ---- 同時実行枠（max_parallel） ----
//
// <共有ディレクトリ>/slot.<i>/（i は 0 から枠数 - 1）を mkdir で取り合う。実行側になる者（と共有しない実行）は
// 枠を 1 つ取ってから走らせ、終わったら消す。中の info.json と pid でロックと同じように生死を判定する。
// 重いコマンドをエージェントの数だけ同時に走らせると CPU の取り合いで全員が何倍も遅くなるので、
// 直列化（同じコマンドは 1 本）に加えて、違うコマンドの同時実行数にも上限を置く。

const slotWaitMs = 5000 // 枠が空くのを 1 回に待つ長さ。超えたら死んだ枠を片付けてから待ち直す

func slotPath(dir string, i int) string { return Join(dir, "slot."+strconv.Itoa(i)) }

// takeSlot は空いている枠を 1 つ取る。死んだ枠は片付けて取り直す。取れなければ ""。枠数が 0 以下（無制限）なら ("", true)。
func takeSlot(io Io, dir string, maxParallel, timeoutMs int64) (string, bool) {
	if maxParallel <= 0 {
		return "", true
	}
	for i := range int(maxParallel) {
		slot := slotPath(dir, i)
		if mkdirAtomic(io, dir, slot) {
			_ = io.WriteFile(Join(slot, "info.json"), JSONStringify(OMap{{"started", io.Now()}, {"timeoutMs", timeoutMs}}))
			return slot, true
		}
		if !io.Exists(slot) {
			return "", true // 枠を作れない（共有ディレクトリに書けないなど）。上限なしで走らせる
		}
		info, hasInfo := (&sharedRun{io: io}).readInfo(slot)
		if (&sharedRun{io: io}).remainingMs(slot, info, hasInfo) <= 0 {
			io.RemoveTree(slot)
			if mkdirAtomic(io, dir, slot) {
				_ = io.WriteFile(Join(slot, "info.json"), JSONStringify(OMap{{"started", io.Now()}, {"timeoutMs", timeoutMs}}))
				return slot, true
			}
		}
	}
	return "", false
}

func releaseSlot(io Io, slot string) {
	if slot != "" {
		io.RemoveTree(slot)
	}
}

// waitSlot はどれかの枠が空くまで（最長 slotWaitMs）待つ。
func waitSlot(io Io, dir string, maxParallel int64) {
	var checks []string
	for i := range int(maxParallel) {
		checks = append(checks, `[ -d "$1/slot.`+strconv.Itoa(i)+`" ]`)
	}
	script := "while " + strings.Join(checks, " && ") + "; do sleep " + pollSeconds + "; done"
	io.Run([]string{"sh", "-c", script, "sh", dir}, RunOptions{TimeoutMs: slotWaitMs})
}

// RunWithSlot は共有も直列化もしない実行を、同時実行枠だけ取って走らせる（share: false 用）。
func RunWithSlot(io Io, maxParallel int, timeoutMs int64, execute func(pidFiles []string) SharedOutcome) SharedOutcome {
	if maxParallel <= 0 {
		return execute(nil)
	}
	dir := SharedDir(io)
	for {
		slot, ok := takeSlot(io, dir, int64(maxParallel), timeoutMs)
		if ok {
			defer releaseSlot(io, slot)
			var pidFiles []string
			if slot != "" {
				pidFiles = []string{Join(slot, "pid")}
			}
			return execute(pidFiles)
		}
		waitSlot(io, dir, int64(maxParallel))
	}
}

func (r *sharedRun) readInfo(lock string) (lockInfo, bool) {
	text, ok := r.io.ReadFile(Join(lock, "info.json"))
	if !ok {
		return lockInfo{}, false
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return lockInfo{}, false // 書きかけは info 無しと同じに扱う
	}
	d, ok := AsDict(v)
	if !ok {
		return lockInfo{}, false
	}
	var info lockInfo
	if s := jsNumber(d["started"]); finite(s) {
		info.started = int64(s)
		info.hasStarted = true
	}
	if l := jsNumber(d["timeoutMs"]); !math.IsNaN(l) && l != 0 {
		info.limit = int64(l)
	}
	if k, ok := d["key"].(string); ok {
		info.key = k
		info.hasKey = true
	}
	if arr, ok := d["files"].([]any); ok {
		info.files = make([]string, len(arr))
		for i, f := range arr {
			info.files[i] = Str(f)
		}
	}
	return info, true
}

// commandGone は pid のコマンドが終わっているときの残り時間: 実行側が結果を書いてロックを外す途中かもしれないので、
// 少しの間ロックが消えるのを待つ。消えたら生きている扱い（graceMs）で返す（呼び出し側は待機に入り、消えているのですぐ抜けて
// 結果を読む）。消えなければ死亡（0）。
func (r *sharedRun) commandGone(lock string) int64 {
	polls := int(math.Ceil(float64(deadGraceMs) / (0.05 * 1000)))
	script := fmt.Sprintf(`i=0; while [ -d "$1" ] && [ "$i" -lt %d ]; do sleep %s; i=$((i+1)); done; [ ! -d "$1" ]`, polls, pollSeconds)
	if r.io.Run([]string{"sh", "-c", script, "sh", lock}, RunOptions{}).ExitCode == 0 {
		return graceMs
	}
	return 0
}

// remainingMs はロックが生きている残り時間。期限切れ、またはコマンドのプロセスが終わっていれば 0 以下。
func (r *sharedRun) remainingMs(lock string, info lockInfo, hasInfo bool) int64 {
	now := r.io.Now()
	started := now
	if hasInfo && info.hasStarted {
		started = info.started
	} else if st, ok := r.io.Stat(lock); ok {
		started = st.MtimeMs
	}
	var limit int64
	if hasInfo {
		limit = info.limit
	}
	left := started + limit + graceMs - now
	if left <= 0 {
		return left
	}
	pidText, _ := r.io.ReadFile(Join(lock, "pid"))
	if pid := strings.TrimSpace(pidText); pid != "" {
		if pidRe.MatchString(pid) && r.io.Run([]string{"sh", "-c", `kill -0 "$1" 2>/dev/null`, "sh", pid}, RunOptions{}).ExitCode == 0 {
			return left
		}
		return r.commandGone(lock)
	}
	// PID がまだ無い。info があるのに graceMs を過ぎても書かれないなら、コマンドを起動する前に止められている。
	if hasInfo && now-started > graceMs {
		return 0
	}
	return left
}

func (r *sharedRun) covers(theirs []string) bool {
	if theirs == nil {
		return false
	}
	for _, f := range r.mine {
		found := false
		for _, t := range theirs {
			if t == f {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

type runningLock struct {
	lock    string
	pending bool
}

// findRunning は同じキーで実行中の、自分のファイル一覧を含むロックを探す。期限切れのロックはここで片付ける。info.json がまだ無い
// ロック（実行側が mkdir してから書くまでの隙間）は、どの一覧か判定できないので pending として返す。
func (r *sharedRun) findRunning() runningLock {
	pending := false
	for _, e := range r.io.List(r.dir) {
		if e.Kind != KindDir || !strings.HasPrefix(e.Name, r.keyPrefix) || !strings.HasSuffix(e.Name, ".run") {
			continue
		}
		l := Join(r.dir, e.Name)
		info, hasInfo := r.readInfo(l)
		alive := r.remainingMs(l, info, hasInfo) > 0
		if !hasInfo {
			if alive {
				pending = true
			}
			continue
		}
		if !info.hasKey || info.key != r.key || !r.covers(info.files) {
			continue
		}
		if !alive {
			r.io.RemoveTree(l)
			continue
		}
		return runningLock{lock: l, pending: pending}
	}
	return runningLock{pending: pending}
}

func (r *sharedRun) readOutcome(resultFile string) (SharedOutcome, bool) {
	text, ok := r.io.ReadFile(resultFile)
	if !ok {
		return SharedOutcome{}, false
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return SharedOutcome{}, false
	}
	d, ok := AsDict(v)
	if !ok || d["key"] != r.key {
		return SharedOutcome{}, false
	}
	arr, ok := d["files"].([]any)
	if !ok {
		return SharedOutcome{}, false
	}
	theirs := make([]string, len(arr))
	for i, f := range arr {
		theirs[i] = Str(f)
	}
	if !r.covers(theirs) {
		return SharedOutcome{}, false
	}
	out := SharedOutcome{Ok: d["ok"] == true, TimedOut: d["timedOut"] == true}
	if d["out"] != nil {
		out.Out = Str(d["out"])
	}
	if d["logpath"] != nil {
		out.Logpath = Str(d["logpath"])
	}
	return out, true
}

func (r *sharedRun) announce() {
	if r.announced {
		return
	}
	r.announced = true
	if r.hooks.OnWait != nil {
		r.hooks.OnWait()
	}
}

// waitGone はロックが消えるか、そのコマンドのプロセスが終わるか、ロックが別の実行のものに替わるまで待つ。終わっていたら、
// 呼び出し側が次のラウンドで奪い直す。消えてから次の実行側が同じパスで作り直すのがポーリングの間に収まると「消えた」
// ことを見逃すので、待ち始めたときの info.json の中身を覚えておき、変わったら起きる（次のラウンドで新しい実行を見に行く）。
func (r *sharedRun) waitGone(path string, left int64) {
	info, _ := r.io.ReadFile(Join(path, "info.json"))
	script := fmt.Sprintf(`while [ -d "$1" ]; do `+
		`if [ -n "$2" ] && [ "$(cat "$1/info.json" 2>/dev/null)" != "$2" ]; then exit 4; fi; `+
		`if [ -s "$1/pid" ] && ! kill -0 "$(cat "$1/pid")" 2>/dev/null; then exit 3; fi; sleep %s; done`, pollSeconds)
	r.io.Run([]string{"sh", "-c", script, "sh", path, info}, RunOptions{TimeoutMs: min(max(left, 1), maxWaitMs)})
}

func (r *sharedRun) sleepPoll() {
	r.io.Run([]string{"sleep", pollSeconds}, RunOptions{})
}

// roundAction は 1 ラウンドの結果。
type roundAction int

const (
	roundDone     roundAction = iota // 結果が出た
	roundNext                        // ラウンドを消費して次へ
	roundRetry                       // ラウンドを消費せず次へ
	roundContinue                    // target を待つ
)

// acquire は受け取れる実行が無いときの処理: 排他ロックを取って実行側になるか、先行する実行を待つ対象にする。
func (r *sharedRun) acquire() (roundAction, string, SharedOutcome) {
	// 実行側になるには同時実行枠が要る。空いていなければ空くのを待って探し直す（その間に受け取れる実行が
	// 始まっていれば、次のラウンドでそれを待つ）。ラウンドは消費しない。
	slot, ok := takeSlot(r.io, r.dir, int64(r.hooks.MaxParallel), r.timeoutMs)
	if !ok {
		waitSlot(r.io, r.dir, int64(r.hooks.MaxParallel))
		return roundRetry, "", SharedOutcome{}
	}
	// 同じ直列化の単位の実行が走っていれば、終わるまで待ってから探し直す。
	if r.mkdirAtomic(r.serialLock) {
		r.absorbRequests()
		if r.mkdirAtomic(r.ownLock) {
			return roundDone, "", r.lead(slot)
		}
		releaseSlot(r.io, slot)
		r.io.RemoveTree(r.serialLock)
		return roundContinue, r.ownLock, SharedOutcome{} // 同じ一覧の実行が info を書く前だった場合など。そのロックを待つ
	}
	releaseSlot(r.io, slot)
	info, hasInfo := r.readInfo(r.serialLock)
	left := r.remainingMs(r.serialLock, info, hasInfo)
	if left <= 0 {
		r.io.RemoveTree(r.serialLock)
		return roundNext, "", SharedOutcome{}
	}
	if !hasInfo {
		// ロックが無いのに作れない（.gate-status に書けないなど）。ラウンドを消費して、尽きたら共有せず自分で実行する
		if !r.io.Exists(r.serialLock) {
			return roundNext, "", SharedOutcome{}
		}
		// 実行側が排他ロックを取ってから info を書くまでの隙間。書かれるのを待って探し直す（ラウンドは消費しない）
		r.sleepPoll()
		return roundRetry, "", SharedOutcome{}
	}
	// info があれば実行のロックの info も書かれている。受け取れる実行なら、それを待つ。
	again := r.findRunning()
	if again.lock == "" {
		// 受け取れない実行を待つ。自分の一覧を置いておき、次の実行側にまとめて走らせてもらう。
		r.postRequest()
		r.announce()
		r.waitGone(r.serialLock, left)
		return roundNext, "", SharedOutcome{}
	}
	return roundContinue, again.lock, SharedOutcome{}
}

// round は 1 ラウンド。結果が出たら (roundDone, outcome, shared)。
func (r *sharedRun) round() (roundAction, SharedResult) {
	found := r.findRunning()
	if found.lock == "" && found.pending {
		// info が現れるのを待って探し直す。猶予を過ぎれば pending でなくなるので、ラウンドは消費しない
		r.sleepPoll()
		return roundRetry, SharedResult{}
	}
	target := found.lock
	if target == "" {
		action, t, outcome := r.acquire()
		if action != roundContinue {
			return action, SharedResult{Outcome: outcome}
		}
		target = t
	}
	info, hasInfo := r.readInfo(target)
	left := r.remainingMs(target, info, hasInfo)
	if left <= 0 {
		r.io.RemoveTree(target)
		return roundNext, SharedResult{}
	}
	r.announce()
	r.waitGone(target, left)
	if r.io.Exists(target) {
		return roundNext, SharedResult{}
	}
	if outcome, ok := r.readOutcome(resultOf(target)); ok {
		return roundDone, SharedResult{Outcome: outcome, Shared: true}
	}
	return roundNext, SharedResult{}
}

// RunShared は key の実行を共有する。files はこの実行が対象にするファイル一覧。execute は実行側になったときだけ呼ばれ、
// 排他ロック・実行ロックの中の pid ファイルのパスを受け取る（コマンドを走らせるシェルの PID を書かせる）。
// execute が panic しても、ロックは外してから伝わる。
func RunShared(
	io Io,
	key string,
	files []string,
	timeoutMs int64,
	execute SharedExecute,
	hooks SharedHooks,
) SharedResult {
	mine := normalizeFiles(files)
	dir := SharedDir(io)
	serial := hooks.Serial
	if serial == "" {
		serial = key
	}
	r := &sharedRun{
		io: io, key: key, mine: mine, timeoutMs: timeoutMs, execute: execute, hooks: hooks, dir: dir,
		keyPrefix:  HashKey(key) + ".",
		ownLock:    Join(dir, ShareID(key, mine)+".run"),
		serialLock: Join(dir, HashKey(serial)+".serial"),
		queueDir:   Join(dir, HashKey(serial)+".queue"),
	}
	defer r.withdrawRequest()
	for round := 0; round < maxRounds; round++ {
		action, res := r.round()
		switch action {
		case roundDone:
			return res
		case roundRetry:
			round--
		case roundNext, roundContinue:
		}
	}
	return SharedResult{Outcome: RunWithSlot(io, hooks.MaxParallel, timeoutMs, func(pidFiles []string) SharedOutcome { return execute(pidFiles, mine) }), Shared: false}
}
