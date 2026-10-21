package hookgate

// Stop hook: gate の checks フェーズ → feedback ルールの stop_check → 完了通知、の順に実行する（src/all-stop.ts）。

// AllStop は Stop hook の本体。
func AllStop(io Io, payload Dict) ScriptResult {
	var stdout, stderr string
	reportConsumed := false
	// gate が 1 つでも止めたらそこで終了し、通知は出さない
	steps := []func() ScriptResult{
		func() ScriptResult { return StopTestGate(io, "checks", payload) },
		func() ScriptResult { return FeedbackStopCheck(io, payload) },
	}
	for _, step := range steps {
		r := step()
		stdout += r.Stdout
		stderr += r.Stderr
		if r.ExitCode != 0 {
			return ScriptResult{ExitCode: r.ExitCode, Stdout: stdout, Stderr: stderr}
		}
		if r.ReportConsumed {
			reportConsumed = true
		}
	}

	// stop_hook_active は Stop hook のブロックで会話が継続している状態を指す。
	// ここで通知すると「Stop hook feedback」のたびに鳴るため除外する。
	// ただし成功報告のブロックは通知なしで返しているので、その直後の Stop（gate が印を消費して通した回）だけは完了として通知する
	if payload["stop_hook_active"] != true || reportConsumed {
		r := Notification(io, "stop", payload)
		stdout += r.Stdout
		stderr += r.Stderr
	}
	return ScriptResult{ExitCode: 0, Stdout: stdout, Stderr: stderr}
}
