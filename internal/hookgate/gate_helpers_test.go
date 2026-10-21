package hookgate

// tests/helpers/gate.ts のうち、gate 本体（Gate / RunGate）に依存する部分（gate / newGate / rules / checks / ioFor）と、
// 偽 dogwood（WriteFakeDogwood / ReadCalls）の移植。gate 非依存の部分は helpers_test.go にある。
//
// TS 版の偽 dogwood は node で動く JS だったが、Go 版は testdata/fakedogwood/main.go を go build したバイナリを
// テストバイナリごとに 1 回だけ作り（sync.Once）、設定ファイルのパスを環境変数で渡す sh のラッパーを DOGWOOD_BIN に差す。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GateOpts は gate / newGate / rules / checks の追加引数（GateOpts）。ゼロ値は「指定なし」。
type GateOpts struct {
	// Session は session_id（既定 sess1）。
	Session        string
	StopHookActive bool
	AgentID        string
	Phase          string
	DogwoodBin     string
	Lang           Lang
}

func gateFirstOpts(opts []GateOpts) GateOpts {
	if len(opts) > 0 {
		return opts[0]
	}
	return GateOpts{}
}

func (o GateOpts) session() string {
	if o.Session == "" {
		return "sess1"
	}
	return o.Session
}

func (o GateOpts) gateOptions() GateOptions {
	return GateOptions{SessionID: o.session(), AgentID: o.AgentID, Phase: o.Phase, StopHookActive: o.StopHookActive}
}

func ioFor(proj string, opts GateOpts) Io {
	env := EnvVars{}
	if opts.DogwoodBin != "" {
		env.DogwoodBin = opts.DogwoodBin
	}
	return MakeIo(IoOpts{ProjectDir: proj, Env: env, Lang: opts.Lang})
}

// gate は gate を1回実行する（phase 省略時は checks）。
func gate(proj string, opts ...GateOpts) ScriptResult {
	o := gateFirstOpts(opts)
	return RunGate(ioFor(proj, o), o.gateOptions())
}

// newGate は状態ファイルの操作に使う Gate インスタンス（Main は呼ばない）。
func newGate(proj string, opts ...GateOpts) *Gate {
	o := gateFirstOpts(opts)
	return NewGate(ioFor(proj, o), o.gateOptions())
}

func rules(proj string, opts ...GateOpts) ScriptResult {
	o := gateFirstOpts(opts)
	o.Phase = "rules"
	return gate(proj, o)
}

func checks(proj string, opts ...GateOpts) ScriptResult {
	o := gateFirstOpts(opts)
	o.Phase = "checks"
	return gate(proj, o)
}

// tmpProj はテスト用の一時プロジェクトディレクトリ（realpath 済み）を作り、テストの終わりに消す。
func tmpProj(t *testing.T) string {
	t.Helper()
	dir := TmpDir()
	t.Cleanup(func() { RmTree(dir) })
	return dir
}

// requireExit0 は終了コードが 0 であること（失敗時は stderr を添える）。TS の `expect(r.exitCode, r.stderr).toBe(0)`。
func requireExit0(t *testing.T, r ScriptResult) {
	t.Helper()
	require.Equal(t, 0, r.ExitCode, r.Stderr)
}

// syncIo は複数の Gate（goroutine）が同じログのスライスへ書くテストのために、画面系の呼び出しを 1 本の mutex で直列にする。
type syncIo struct {
	Io
	mu *sync.Mutex
}

func (s syncIo) Progress(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Io.Progress(text)
}

func (s syncIo) Result(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Io.Result(text)
}

func (s syncIo) Redraw() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Io.Redraw()
}

// ---- 偽 dogwood ----
// 実 dogwood バイナリに依存させない。DOGWOOD_BIN に下記の偽バイナリを差し、verdict / 異常終了 / 壊れた出力を制御する。

var (
	fakeDogwoodOnce sync.Once
	fakeDogwoodPath string
)

// builtFakeDogwood は testdata/fakedogwood をビルドしたバイナリのパス（テストバイナリごとに 1 回だけビルドする）。
func builtFakeDogwood() string {
	fakeDogwoodOnce.Do(func() {
		out := filepath.Join(TestHome, "fakedogwood-bin")
		cmd := exec.CommandContext(context.Background(), "go", "build", "-o", out, "./internal/hookgate/testdata/fakedogwood")
		cmd.Dir = RepoRoot
		if b, err := cmd.CombinedOutput(); err != nil {
			panic(fmt.Sprintf("go build fakedogwood: %v\n%s", err, b))
		}
		fakeDogwoodPath = out
	})
	return fakeDogwoodPath
}

// FakeDogwoodOpts は偽 dogwood の振る舞い。Verdict の既定は allow、Mode の既定は ok（ok / fail / broken / empty）。
type FakeDogwoodOpts struct {
	Verdict string
	Mode    string
	// Deny は、トレースの最後の行がこれらの部分文字列を含むとき deny を返す。
	Deny []string
	// DenyAfterFirstCall は、トレースの最後の行がこれらを含むとき、1 回目は Verdict、2 回目以降は deny を返す。
	DenyAfterFirstCall []string
}

// WriteFakeDogwood は偽 dogwood を作り (バイナリパス, 呼び出し記録 jsonl のパス) を返す。
func WriteFakeDogwood(dir string, opts ...FakeDogwoodOpts) (string, string) {
	var o FakeDogwoodOpts
	if len(opts) > 0 {
		o = opts[0]
	}
	must(os.MkdirAll(dir, 0o755))
	calls := filepath.Join(dir, "calls.jsonl")
	conf := filepath.Join(dir, "conf.json")
	if o.Verdict == "" {
		o.Verdict = "allow"
	}
	if o.Mode == "" {
		o.Mode = "ok"
	}
	deny, flip := o.Deny, o.DenyAfterFirstCall
	if deny == nil {
		deny = []string{}
	}
	if flip == nil {
		flip = []string{}
	}
	writeText(conf, JSONStringify(Dict{"verdict": o.Verdict, "mode": o.Mode, "deny": deny, "deny_after_first_call": flip, "calls": calls}))
	bin := filepath.Join(dir, "dogwood")
	writeText(bin, "#!/bin/sh\nFAKE_DOGWOOD_CONF="+ShellQuote(conf)+" exec "+ShellQuote(builtFakeDogwood())+" \"$@\"\n")
	must(os.Chmod(bin, 0o755))
	return bin, calls
}

// FakeCall は偽 dogwood が受けた 1 回の呼び出し。
type FakeCall struct {
	Argv  []string `json:"argv"`
	Trace string   `json:"trace"`
}

// ReadCalls は偽 dogwood の呼び出し記録。無ければ空。
func ReadCalls(calls string) []FakeCall {
	out := []FakeCall{}
	if !Exists(calls) {
		return out
	}
	for _, l := range Lines(calls) {
		var c FakeCall
		must(json.Unmarshal([]byte(l), &c))
		out = append(out, c)
	}
	return out
}

func TestFakeDogwood(t *testing.T) {
	t.Run("fake dogwood is executable and answers with the configured verdict", func(t *testing.T) {
		dir := tmpProj(t)
		bin, calls := WriteFakeDogwood(dir, FakeDogwoodOpts{Verdict: "deny"})
		out, err := exec.CommandContext(context.Background(), bin, "replay", "p.dw").Output()
		require.NoError(t, err)
		assert.JSONEq(t, `{"verdicts":[{"index":0,"verdict":"deny"}]}`, string(out))
		got := ReadCalls(calls)
		require.Len(t, got, 1)
		assert.Equal(t, []string{"replay", "p.dw"}, got[0].Argv)
	})
}
