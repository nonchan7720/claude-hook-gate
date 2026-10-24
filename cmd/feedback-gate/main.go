// Command feedback-gate is the single binary behind the Claude Code / Codex command hooks.
//
//	feedback-gate claude <Event>   Claude Code settings hook
//	feedback-gate codex  <Event>   Codex plugin hook
//	feedback-gate version          print the version
package main

import (
	"fmt"
	"os"

	"github.com/nonchan7720/claude-hook-gate/internal/hookgate"
)

// version is the plugin version (release-please rewrites the line marked x-release-please-version together with
// .claude-plugin/plugin.json); GoReleaser overrides it with -ldflags "-X main.version=<tag>" so a release build and the
// manifest always agree.
var version = "0.13.0" // x-release-please-version

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) >= 1 {
		switch args[0] {
		case "claude":
			return hookgate.CliMain(hookgate.ClaudeHost, args[1:], os.Stdin, os.Stdout, os.Stderr)
		case "codex":
			return hookgate.CliMain(hookgate.CodexHost, args[1:], os.Stdin, os.Stdout, os.Stderr)
		case "version":
			if len(args) == 1 {
				fmt.Println(version)
				return 0
			}
		}
	}
	fmt.Fprintln(os.Stderr, "usage: feedback-gate <claude|codex> <Event>")
	return 1
}
