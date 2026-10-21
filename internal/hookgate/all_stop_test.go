package hookgate

// src/all-stop.ts のテスト。TS 版に専用の spec は無い（hooks / register 越しに触れるだけ）ので、gate.yaml と feedback ルールを持つ
// プロジェクトで、gate の checks フェーズ → feedback の stop_check → 完了通知の順序と、止めたときの打ち切りを確かめる。
// 順序は、偽の terminal-notifier と gate の検証コマンドが共通の記録ファイルへ書く行で見る
// （検証コマンドは違反ログが無いうちに走り、通知は違反ログが出来た後に走るはず）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type allStopEnv struct {
	t     *testing.T
	proj  string
	fb    string
	trace string
}

// allStopSetup は一時プロジェクトと feedback ディレクトリ、偽の terminal-notifier（実行を trace に記録する）を用意する。
// withNotifier が false なら PATH に terminal-notifier は無い。
func allStopSetup(t *testing.T, withNotifier bool) allStopEnv {
	t.Helper()
	proj := tmpProj(t)
	fb := TmpDir("all-stop-fb-")
	t.Cleanup(func() { RmTree(fb) })
	logDir := t.TempDir()
	e := allStopEnv{t: t, proj: proj, fb: fb, trace: filepath.Join(logDir, "trace.txt")}
	if withNotifier {
		bin := notificationFakePath(t)
		script := "#!/bin/sh\n" +
			"echo notify >> '" + e.trace + "'\n" +
			"if [ -f '" + e.violations() + "' ]; then echo notify-after-stop-check >> '" + e.trace + "'; fi\n"
		require.NoError(t, os.WriteFile(filepath.Join(bin, "terminal-notifier"), []byte(script), 0o755))
	} else {
		// terminal-notifier の無い PATH（sh などは残す）。
		t.Setenv("PATH", "/usr/bin:/bin")
	}
	return e
}

func (e allStopEnv) violations() string { return filepath.Join(e.fb, ".violations.jsonl") }

func (e allStopEnv) io() Io {
	return MakeIo(IoOpts{ProjectDir: e.proj, Env: EnvVars{ClaudeFeedbackDir: e.fb}})
}

func (e allStopEnv) traceLines() []string {
	if !Exists(e.trace) {
		return []string{}
	}
	return Lines(e.trace)
}

// gateYaml は gate の検証 chk を持つ gate.yaml を書く。検証コマンドは chkRun（既定は trace に gate / gate-after-stop-check を残す）。
func (e allStopEnv) gateYaml(chkRun string) {
	if chkRun == "" {
		chkRun = "if [ -f '" + e.violations() + "' ]; then echo gate-after-stop-check >> '" + e.trace + "'; else echo gate >> '" + e.trace + "'; fi"
	}
	WriteGateYaml(e.proj, Dict{
		"report_success":     false,
		"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
		"consistency_checks": gList(Dict{"name": "chk", "run": gList(chkRun)}),
	})
}

// reserve は x.py を gate の rules フェーズに通して検証 chk を予約させ、そのあとで README.md を変更ファイルのメモに入れる
// （stop_check はメモの README.md を見る。README.md は gate のどのルールにも当たらないので、checks フェーズでも消えない）。
func (e allStopEnv) reserve() {
	WriteChangedFiles(e.proj, "sess1", "x.py")
	requireExit0(e.t, rules(e.proj))
	fbtWrite(filepath.Join(e.proj, "README.md"), "")
	WriteChangedFiles(e.proj, "sess1", "README.md")
}

func (e allStopEnv) readmeRule(severity string) {
	content := strings.Join([]string{
		"---",
		"name: readme_bilingual",
		"description: test",
		"type: feedback",
		"count: 4",
		"enforce:",
		"  - event: stop_check",
		"    changed: '**/README.md'",
		"    require_sibling: 'README_ja.md'",
		"    message: '日英併記のこと'",
		"    severity: " + severity,
		"---",
		"",
		"本文",
		"",
	}, "\n")
	fbtWrite(filepath.Join(e.fb, "readme_bilingual.md"), content)
}

func allStopPayload(extra Dict) Dict {
	p := Dict{"session_id": "sess1"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func TestAllStop(t *testing.T) {
	t.Run("runs the gate checks, then stop_check, then the notification", func(t *testing.T) {
		e := allStopSetup(t, true)
		e.gateYaml("")
		e.readmeRule("warn")
		e.reserve()
		r := AllStop(e.io(), allStopPayload(nil))
		assert.Equal(t, 0, r.ExitCode)
		// stop_check の警告（warn のみなので止めない）。gate の stdout より後ろに続く stderr に出る
		assert.Contains(t, r.Stderr, "[feedback-stop-check] warn: readme_bilingual (count: 4): 日英併記のこと")
		assert.NotContains(t, r.Stdout, `"decision":"block"`)
		// gate の検証は違反ログが出来る前、通知は違反ログが出来た後
		assert.Equal(t, []string{"gate", "notify", "notify-after-stop-check"}, e.traceLines())
		assert.True(t, Exists(e.violations()))
		// 検証が通ったので予約は消えている
		assert.False(t, Exists(PendingPath(e.proj, "sess1")))
	})

	t.Run("a block from the gate ends the stop: no stop_check, no notification", func(t *testing.T) {
		e := allStopSetup(t, true)
		e.gateYaml("echo gate >> '" + e.trace + "'; exit 1")
		e.readmeRule("block")
		e.reserve()
		r := AllStop(e.io(), allStopPayload(nil))
		assert.Equal(t, 2, r.ExitCode)
		body := allStopLastJSON(t, r.Stdout)
		assert.Equal(t, "block", body["decision"])
		assert.Contains(t, body["reason"], "検証に失敗しました")
		// stop_check は走らない（違反ログも出力も無い）
		assert.NotContains(t, r.Stdout+r.Stderr, "feedback-stop-check")
		assert.False(t, Exists(e.violations()))
		// 通知も出ない
		assert.Equal(t, []string{"gate"}, e.traceLines())
	})

	t.Run("a block from stop_check ends the stop: exit 2, the gate output is kept, no notification", func(t *testing.T) {
		e := allStopSetup(t, true)
		e.gateYaml("")
		e.readmeRule("block")
		e.reserve()
		r := AllStop(e.io(), allStopPayload(nil))
		assert.Equal(t, 2, r.ExitCode)
		body := allStopLastJSON(t, r.Stdout)
		assert.Equal(t, "block", body["decision"])
		assert.Contains(t, body["reason"], "[feedback-stop-check] readme_bilingual (count: 4): 日英併記のこと")
		assert.Contains(t, r.Stderr, "[feedback-stop-check] readme_bilingual")
		// gate は先に走って通っている。通知は出ない
		assert.Equal(t, []string{"gate"}, e.traceLines())
	})

	t.Run("nothing applies: no output and exit 0", func(t *testing.T) {
		e := allStopSetup(t, false)
		assert.Equal(t, Ok("", ""), AllStop(e.io(), allStopPayload(nil)))
		// gate.yaml と feedback ルールがあっても、検証も変更ファイルも無ければ何も出ない
		e.gateYaml("")
		e.readmeRule("block")
		assert.Equal(t, Ok("", ""), AllStop(e.io(), allStopPayload(nil)))
		assert.Equal(t, []string{}, e.traceLines())
	})

	t.Run("no notification while stop_hook_active is true", func(t *testing.T) {
		e := allStopSetup(t, true)
		// stop_hook_active でなければ通知する
		assert.Equal(t, Ok("", ""), AllStop(e.io(), allStopPayload(nil)))
		assert.Equal(t, []string{"notify"}, e.traceLines())
		require.NoError(t, os.Remove(e.trace))
		// stop_hook_active が true なら Stop hook のブロックで続いている会話なので鳴らさない
		assert.Equal(t, Ok("", ""), AllStop(e.io(), allStopPayload(Dict{"stop_hook_active": true})))
		assert.Equal(t, []string{}, e.traceLines())
	})

	t.Run("the stop right after a success report is notified even though stop_hook_active is true", func(t *testing.T) {
		e := allStopSetup(t, true)
		// 成功報告を出す gate（report_success 既定）
		WriteGateYaml(e.proj, Dict{
			"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
			"consistency_checks": gList(Dict{"name": "chk", "run": gList("echo gate >> '" + e.trace + "'")}),
		})
		WriteChangedFiles(e.proj, "sess1", "x.py")
		requireExit0(t, rules(e.proj))
		first := AllStop(e.io(), allStopPayload(nil))
		// 成功報告のブロック（通知なしで返す）
		assert.Equal(t, 2, first.ExitCode)
		assert.Equal(t, []string{"gate"}, e.traceLines())
		// 予約が残っていても走らせず、成功報告の印を消費して通す。この回は完了として通知する
		WritePending(e.proj, "sess1", Dict{e.proj: Dict{"chk": gList("x.py")}})
		followUp := AllStop(e.io(), allStopPayload(Dict{"stop_hook_active": true}))
		assert.Equal(t, 0, followUp.ExitCode)
		assert.False(t, followUp.ReportConsumed)
		assert.Equal(t, []string{"gate", "notify"}, e.traceLines())
	})
}

// allStopLastJSON は stdout の最後の行（JSON）を読む。
func allStopLastJSON(t *testing.T, stdout string) Dict {
	t.Helper()
	ls := strings.Split(strings.TrimSpace(stdout), "\n")
	var d Dict
	require.NoError(t, json.Unmarshal([]byte(ls[len(ls)-1]), &d), stdout)
	return d
}
