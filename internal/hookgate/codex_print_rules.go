package hookgate

// `feedback-gate codex print-rules`: UserPromptSubmit が毎回のプロンプトに足す内容（rules ファイルと、確定した feedback ルール）を
// そのまま標準出力に出す。Codex がどの hook も走らせない環境（管理者の allow_managed_hooks_only で、管理者が managed hooks を配ってくれない）
// で、AGENTS.md（~/.codex/AGENTS.md かプロジェクトの AGENTS.md）に貼って、少なくともルールの文面だけは Codex に届けるためのもの。
// 検査（deny / ask / block、gate）は hook 無しには動かないので、これは代わりにならない。

import (
	"fmt"
	"io"
	"strings"
)

// CodexPrintRules は print-rules の入口。env は環境変数、cwd は現在のディレクトリ（プロジェクトのルールはここから探す）。
// 終了コードを返す（0: 成功、1: 使い方）。
func CodexPrintRules(args []string, env map[string]string, cwd string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		_, _ = fmt.Fprintln(stderr, "usage: feedback-gate codex print-rules   (prints what UserPromptSubmit adds to the context: the rules file and the confirmed feedback rules of ~/{.agents,.claude}/feedback and <cwd>/{.agents,.claude}/feedback)")
		return 1
	}
	options := CodexHost.Options(env)
	osIo := MakeOsIo(OsIoInit{
		Environ:        env,
		PayloadCwd:     cwd,
		Language:       options.Language,
		AutoCount:      BoolPtr(false),
		AppName:        CodexHost.AppName(),
		ConfigDirNames: CodexHost.ConfigDirNames(),
	})
	run := UserPromptSubmit(osIo, "print-rules", options)
	var parts []string
	for _, c := range run.Outcome.AdditionalContext {
		if strings.TrimFunc(c, isJSSpace) != "" {
			parts = append(parts, strings.TrimRight(c, "\n"))
		}
	}
	if len(parts) > 0 {
		_, _ = io.WriteString(stdout, strings.Join(parts, "\n\n")+"\n")
	}
	_, _ = io.WriteString(stderr, run.Stderr)
	return 0
}
