package hookgate

// Step は 1 イベントの処理を構成する 1 段。
// 各段は classic コマンド hook のスクリプトと同じ { exitCode, stdout, stderr } を返し、hooks.go が classic の規約で Outcome にまとめる。
type Step func(io Io) ScriptResult
