package hookgate

// 同じキーのコマンド実行を、複数のエージェント（hook）の間で 1 本にまとめる（single-flight）。
//
// メインとサブエージェントの hook が同じプロセスで動く保証はないので、プロセス内の状態には頼らず、
// 共有ディレクトリ（下記 SharedDir）配下のファイルで調停する:
//   - <キーのハッシュ>.<ファイル一覧のハッシュ>.run/   ロックディレクトリ。`mkdir` は原子的なので、作れた側が
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
type SharedHooks struct {
	OnWait func()
	Serial string
}

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
	execute    func(pidFiles []string) SharedOutcome
	hooks      SharedHooks
	dir        string
	keyPrefix  string
	ownLock    string
	serialLock string
	announced  bool
}

func resultOf(lock string) string { return strings.TrimSuffix(lock, ".run") + ".result.json" }

func (r *sharedRun) mkdirAtomic(path string) bool {
	return r.io.Run([]string{"sh", "-c", `mkdir -p "$1" && mkdir "$2"`, "sh", r.dir, path}, RunOptions{}).ExitCode == 0
}

// lead は排他ロックを持った状態で実行し、結果を書いてから両方のロックを外す。
func (r *sharedRun) lead() SharedOutcome {
	io := r.io
	resultFile := resultOf(r.ownLock)
	defer io.RemoveTree(r.serialLock)
	started := io.Now()
	// 実行のロックの info を先に書く。排他ロックの info が見えた時点で、待つ側が受け取れる実行かを判定できるように。
	_ = io.WriteFile(Join(r.ownLock, "info.json"), JSONStringify(OMap{{"started", started}, {"timeoutMs", r.timeoutMs}, {"key", r.key}, {"files", r.mine}}))
	_ = io.WriteFile(Join(r.serialLock, "info.json"), JSONStringify(OMap{{"started", started}, {"timeoutMs", r.timeoutMs}}))
	io.RemoveFiles([]string{resultFile})
	defer io.RemoveTree(r.ownLock)
	outcome := r.execute([]string{Join(r.serialLock, "pid"), Join(r.ownLock, "pid")})
	_ = io.WriteFile(resultFile, JSONStringify(OMap{
		{"key", r.key}, {"files", r.mine}, {"out", outcome.Out}, {"ok", outcome.Ok}, {"timedOut", outcome.TimedOut}, {"logpath", outcome.Logpath},
	}))
	return outcome
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

// waitGone はロックが消えるか、そのコマンドのプロセスが終わるまで待つ。終わっていたら、呼び出し側が次のラウンドで奪い直す。
func (r *sharedRun) waitGone(path string, left int64) {
	script := fmt.Sprintf(`while [ -d "$1" ]; do if [ -s "$1/pid" ] && ! kill -0 "$(cat "$1/pid")" 2>/dev/null; then exit 3; fi; sleep %s; done`, pollSeconds)
	r.io.Run([]string{"sh", "-c", script, "sh", path}, RunOptions{TimeoutMs: min(max(left, 1), maxWaitMs)})
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
	// 同じ直列化の単位の実行が走っていれば、終わるまで待ってから探し直す。
	if r.mkdirAtomic(r.serialLock) {
		if r.mkdirAtomic(r.ownLock) {
			return roundDone, "", r.lead()
		}
		r.io.RemoveTree(r.serialLock)
		return roundContinue, r.ownLock, SharedOutcome{} // 同じ一覧の実行が info を書く前だった場合など。そのロックを待つ
	}
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
	execute func(pidFiles []string) SharedOutcome,
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
	}
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
	return SharedResult{Outcome: execute(nil), Shared: false}
}
