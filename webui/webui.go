// Package webui embeds the HTML page of `feedback-gate <host> hook-list` (internal/hookgate/hook_list.go), which the
// Claude Code /hook-list command (src/hook-list.ts) runs through scripts/hook-list.sh.
package webui

import _ "embed"

// HookListHTML is webui/hook-list.html. Its "__HOOK_LIST_DATA__" (a JSON string, quotes included) is replaced with the JSON of the hook list.
//
//go:embed hook-list.html
var HookListHTML string
