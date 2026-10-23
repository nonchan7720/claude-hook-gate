package hookgate

// `feedback-gate codex install-hooks`: プラグイン同梱の hooks.json（plugins/codex/hooks/hooks.json）を、Codex がプラグインの hook を
// 走らせない環境向けに設定層へ写す。
//
// Codex がプラグイン同梱の hook を走らせないのは次の 2 つの場合で、どちらも Claude Code の「組織のガードが mod の classic.* を飛ばす」
// のと同じく、プラグインの側からは直せない:
//   - plugin_hooks の機能フラグが無効な build（openai/codex#16430）。プラグインは入るが hooks/hooks.json は読まれない。
//     → ~/.codex/hooks.json（既定）かプロジェクトの .codex/hooks.json に写す（--to / --project）。
//   - 管理者の requirements.toml が allow_managed_hooks_only = true。ユーザー・プロジェクト・セッション・プラグインの hook が
//     すべて飛ばされ、管理層（/etc/codex/hooks.json、requirements.toml の [hooks]）だけが動く。ユーザーの側に回避はなく、
//     管理者が配る必要がある → --print（hooks.json の形）か --toml（requirements.toml の [hooks] の形）で出し、管理者に渡す。
//
// 写しは `${PLUGIN_ROOT}` をプラグインのルート（絶対パス）に置き換えたもの。既存のファイルの他の hook は残し、このプラグインの
// hook（command に plugins/codex/scripts/hook.sh を含むもの）だけを置き換えるので、何度実行しても 1 組になる。--remove で外す。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CodexHooksTemplate はプラグインのルートからの hooks.json の相対パス。
const CodexHooksTemplate = "plugins/codex/hooks/hooks.json"

// codexHookScriptMark は command がこのプラグインの hook であることの印。
const codexHookScriptMark = "plugins/codex/scripts/hook.sh"

// codexInstallHooksUsage は使い方。
const codexInstallHooksUsage = `usage: feedback-gate codex install-hooks [--root <plugin root>] [--to <hooks.json> | --project [<dir>] | --print | --toml] [--remove]

Copies the plugin's Codex hooks (plugins/codex/hooks/hooks.json, with ${PLUGIN_ROOT} resolved) into a hooks.json that Codex reads
even where it does not run plugin-bundled hooks. Default target: $CODEX_HOME/hooks.json (~/.codex/hooks.json).

  --root <dir>      the plugin root (a checkout, or ~/.codex/plugins/cache/hook-gate/feedback-gate/<version>);
                    default: $PLUGIN_ROOT, $CLAUDE_PLUGIN_ROOT, else the current directory
  --to <file>       write into this hooks.json (merged; other hooks in it are kept)
  --project [<dir>] write into <dir>/.codex/hooks.json (default: the current directory)
  --print           print the hooks.json to stdout instead (for /etc/codex/hooks.json or a managed copy)
  --toml            print the hooks as [hooks] tables for requirements.toml (allow_managed_hooks_only environments)
  --remove          remove this plugin's hooks from the target instead of adding them
`

// codexInstallOpts は解析した引数。
type codexInstallOpts struct {
	root   string
	target string
	print  bool
	toml   bool
	remove bool
}

// CodexInstallHooks は install-hooks の入口。env は環境変数、cwd は現在のディレクトリ。終了コードを返す（0: 成功、1: 失敗 / 使い方）。
func CodexInstallHooks(args []string, env map[string]string, cwd string, stdout, stderr io.Writer) int {
	opts, err := parseCodexInstallArgs(args, env, cwd)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "feedback-gate: %v\n%s", err, codexInstallHooksUsage)
		return 1
	}
	if err := runCodexInstall(opts, stdout); err != nil {
		_, _ = fmt.Fprintf(stderr, "feedback-gate: %v\n", err)
		return 1
	}
	return 0
}

func parseCodexInstallArgs(args []string, env map[string]string, cwd string) (codexInstallOpts, error) {
	opts := codexInstallOpts{root: env["PLUGIN_ROOT"]}
	if opts.root == "" {
		opts.root = env["CLAUDE_PLUGIN_ROOT"]
	}
	if opts.root == "" {
		opts.root = cwd
	}
	targets := 0
	project := ""
	hasProject := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--root", "--to":
			if i+1 >= len(args) || args[i+1] == "" {
				return opts, fmt.Errorf("%s needs a value", a)
			}
			i++
			if a == "--root" {
				opts.root = args[i]
			} else {
				opts.target = args[i]
				targets++
			}
		case "--project":
			hasProject = true
			project = cwd
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				project = args[i]
			}
			targets++
		case "--print":
			opts.print = true
			targets++
		case "--toml":
			opts.toml = true
			targets++
		case "--remove":
			opts.remove = true
		case "-h", "--help":
			return opts, errors.New("help")
		default:
			return opts, fmt.Errorf("unknown argument %q", a)
		}
	}
	if targets > 1 {
		return opts, errors.New("--to, --project, --print and --toml exclude each other")
	}
	if opts.remove && (opts.print || opts.toml) {
		return opts, errors.New("--remove needs a file target (--to or --project)")
	}
	if hasProject {
		opts.target = filepath.Join(absOf(project, cwd), ".codex", "hooks.json")
	}
	if opts.target == "" && !opts.print && !opts.toml {
		codexHome := env["CODEX_HOME"]
		if codexHome == "" {
			home := env["HOME"]
			if home == "" {
				return opts, errors.New("neither CODEX_HOME nor HOME is set; pass --to <hooks.json>")
			}
			codexHome = filepath.Join(home, ".codex")
		}
		opts.target = filepath.Join(codexHome, "hooks.json")
	}
	opts.root = absOf(opts.root, cwd)
	if opts.target != "" {
		opts.target = absOf(opts.target, cwd)
	}
	return opts, nil
}

// absOf は p を cwd 基準の絶対パスにする。
func absOf(p, cwd string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(cwd, p))
}

// codexHookGroup は hooks.json の 1 グループ（matcher と hooks）。
type codexHookGroup struct {
	Event   string
	Matcher string
	Hooks   []OMap
}

// LoadCodexHooksTemplate は <root>/plugins/codex/hooks/hooks.json を読み、${PLUGIN_ROOT} を root に置き換えたグループをイベント順に返す。
func LoadCodexHooksTemplate(root string) ([]codexHookGroup, error) {
	path := filepath.Join(root, filepath.FromSlash(CodexHooksTemplate))
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%s is not a feedback-gate plugin root (%s not found); pass --root", root, CodexHooksTemplate)
	}
	doc, err := decodeOrderedJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	top, _ := doc.(OMap)
	hooks, _ := top.get("hooks").(OMap)
	var groups []codexHookGroup
	for _, kv := range hooks {
		list, _ := kv.Val.([]any)
		for _, g := range list {
			gm, _ := g.(OMap)
			group := codexHookGroup{Event: kv.Key}
			if m, ok := gm.get("matcher").(string); ok {
				group.Matcher = m
			}
			hs, _ := gm.get("hooks").([]any)
			for _, h := range hs {
				hm, _ := h.(OMap)
				if hm == nil {
					continue
				}
				out := make(OMap, 0, len(hm))
				for _, f := range hm {
					if f.Key == "command" {
						if cmd, ok := f.Val.(string); ok {
							f.Val = strings.ReplaceAll(cmd, "${PLUGIN_ROOT}", root)
						}
					}
					out = append(out, f)
				}
				group.Hooks = append(group.Hooks, out)
			}
			groups = append(groups, group)
		}
	}
	if len(groups) == 0 {
		return nil, fmt.Errorf("%s has no hooks", path)
	}
	return groups, nil
}

func (g codexHookGroup) toOMap() OMap {
	out := OMap{}
	if g.Matcher != "" {
		out = append(out, KV{"matcher", g.Matcher})
	}
	hooks := make([]any, 0, len(g.Hooks))
	for _, h := range g.Hooks {
		hooks = append(hooks, h)
	}
	return append(out, KV{"hooks", hooks})
}

// isCodexPluginGroup はグループがこのプラグインのもの（command がすべて plugins/codex/scripts/hook.sh を含む）か。
func isCodexPluginGroup(g any) bool {
	gm, ok := g.(OMap)
	if !ok {
		return false
	}
	hs, _ := gm.get("hooks").([]any)
	if len(hs) == 0 {
		return false
	}
	for _, h := range hs {
		hm, _ := h.(OMap)
		cmd, _ := hm.get("command").(string)
		if !strings.Contains(cmd, codexHookScriptMark) {
			return false
		}
	}
	return true
}

// MergeCodexHooks は existing（hooks.json の内容。nil なら空）からこのプラグインのグループを外し、remove でなければ groups を足す。
// 他の hook とキーの順序は保つ。戻り値は新しい文書と、外した数・足した数。
func MergeCodexHooks(existing OMap, groups []codexHookGroup, remove bool) (OMap, int, int) {
	removed := 0
	hooksVal, _ := existing.get("hooks").(OMap)
	hooks := OMap{}
	for _, kv := range hooksVal {
		list, ok := kv.Val.([]any)
		if !ok {
			hooks = append(hooks, kv)
			continue
		}
		kept := make([]any, 0, len(list))
		for _, g := range list {
			if isCodexPluginGroup(g) {
				removed++
				continue
			}
			kept = append(kept, g)
		}
		if len(kept) > 0 {
			hooks = append(hooks, KV{kv.Key, kept})
		}
	}
	added := 0
	if !remove {
		for _, g := range groups {
			hooks = hooks.appendTo(g.Event, g.toOMap())
			added++
		}
	}
	out := OMap{}
	placed := false
	for _, kv := range existing {
		if kv.Key == "hooks" {
			out = append(out, KV{"hooks", hooks})
			placed = true
			continue
		}
		out = append(out, kv)
	}
	if !placed {
		out = append(OMap{KV{"hooks", hooks}}, out...)
	}
	return out, removed, added
}

func runCodexInstall(opts codexInstallOpts, stdout io.Writer) error {
	groups, err := LoadCodexHooksTemplate(opts.root)
	if err != nil {
		return err
	}
	if opts.toml {
		_, _ = io.WriteString(stdout, CodexHooksToml(groups))
		return nil
	}
	if opts.print {
		doc, _, _ := MergeCodexHooks(nil, groups, false)
		_, _ = io.WriteString(stdout, indentJSON(doc))
		return nil
	}
	var existing OMap
	if data, err := os.ReadFile(opts.target); err == nil {
		if len(bytes.TrimSpace(data)) > 0 {
			doc, err := decodeOrderedJSON(data)
			if err != nil {
				return fmt.Errorf("%s is not valid JSON (%w); fix or remove it first", opts.target, err)
			}
			existing, _ = doc.(OMap)
			if existing == nil {
				return fmt.Errorf("%s is not a JSON object; fix or remove it first", opts.target)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s: %w", opts.target, err)
	}
	doc, removed, added := MergeCodexHooks(existing, groups, opts.remove)
	if opts.remove && removed == 0 {
		_, _ = fmt.Fprintf(stdout, "feedback-gate: no feedback-gate hooks in %s; nothing to do\n", opts.target)
		return nil
	}
	if err := writeFileAtomic(opts.target, indentJSON(doc)); err != nil {
		return fmt.Errorf("%s: %w", opts.target, err)
	}
	events := make([]string, 0, len(groups))
	seen := map[string]bool{}
	for _, g := range groups {
		if !seen[g.Event] {
			seen[g.Event] = true
			events = append(events, g.Event)
		}
	}
	if opts.remove {
		_, _ = fmt.Fprintf(stdout, "feedback-gate: removed %d feedback-gate hook group(s) from %s\n", removed, opts.target)
		return nil
	}
	verb := "added"
	if removed > 0 {
		verb = "replaced"
	}
	_, _ = fmt.Fprintf(stdout, "feedback-gate: %s %d hook group(s) (%s) in %s, plugin root %s\n", verb, added, strings.Join(events, ", "), opts.target, opts.root)
	return nil
}

// CodexHooksToml は groups を requirements.toml の [hooks] の形（[[hooks.<Event>]] と [[hooks.<Event>.hooks]]）にする。
func CodexHooksToml(groups []codexHookGroup) string {
	var b strings.Builder
	b.WriteString("# feedback-gate: the Codex hooks of plugins/codex/hooks/hooks.json as managed hooks for requirements.toml.\n")
	b.WriteString("# With allow_managed_hooks_only = true only these run; pin [features].hooks = true so a user cannot turn them off.\n")
	b.WriteString("# The scripts are not distributed by Codex: the plugin root below must exist on every machine (MDM, image, checkout).\n\n")
	for _, g := range groups {
		fmt.Fprintf(&b, "[[hooks.%s]]\n", g.Event)
		if g.Matcher != "" {
			fmt.Fprintf(&b, "matcher = %s\n", tomlString(g.Matcher))
		}
		for _, h := range g.Hooks {
			fmt.Fprintf(&b, "\n[[hooks.%s.hooks]]\n", g.Event)
			for _, kv := range h {
				switch v := kv.Val.(type) {
				case string:
					fmt.Fprintf(&b, "%s = %s\n", kv.Key, tomlString(v))
				case json.Number:
					fmt.Fprintf(&b, "%s = %s\n", kv.Key, v.String())
				case bool:
					fmt.Fprintf(&b, "%s = %t\n", kv.Key, v)
				}
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// tomlString は TOML の basic string（"..."）。
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04X`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// get は OMap のキーの値（無ければ nil）。
func (m OMap) get(key string) any {
	for _, kv := range m {
		if kv.Key == key {
			return kv.Val
		}
	}
	return nil
}

// appendTo はキーの配列に v を足す（キーが無ければ作る）。
func (m OMap) appendTo(key string, v any) OMap {
	for i, kv := range m {
		if kv.Key == key {
			list, _ := kv.Val.([]any)
			list = append(list, v)
			m[i].Val = list
			return m
		}
	}
	return append(m, KV{key, []any{v}})
}

// decodeOrderedJSON は JSON をキーの順序を保って読む（オブジェクトは OMap、配列は []any、数値は json.Number）。
func decodeOrderedJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeOrderedValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data after the JSON value")
	}
	return v, nil
}

func decodeOrderedValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := OMap{}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				val, err := decodeOrderedValue(dec)
				if err != nil {
					return nil, err
				}
				obj = append(obj, KV{key, val})
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			return obj, nil
		case '[':
			list := []any{}
			for dec.More() {
				val, err := decodeOrderedValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, val)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return list, nil
		}
		return nil, fmt.Errorf("unexpected %v", t)
	default:
		return tok, nil
	}
}

// indentJSON は 2 スペースのインデントで整形した JSON（末尾に改行）。
func indentJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "null\n"
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return string(raw) + "\n"
	}
	return out.String() + "\n"
}

// writeFileAtomic は同じディレクトリの一時ファイルに書いてから rename する（途中のファイルを Codex が読まないように）。
func writeFileAtomic(path, text string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // 設定ディレクトリの既定の権限
		return err
	}
	tmp, err := os.CreateTemp(dir, ".hooks.json.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(text); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil { //nolint:gosec // 設定ファイルの既定の権限
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}
