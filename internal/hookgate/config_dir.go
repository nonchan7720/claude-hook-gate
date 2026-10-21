package hookgate

// 設定ディレクトリ（<project>/.claude と <project>/.agents、~/.claude と ~/.agents）の候補と解決。

// ClaudeConfigDirs は Claude Code の候補。Codex は逆順（host_codex.go）。
var ClaudeConfigDirs = []string{".claude", ".agents"}

// PickConfigDir は状態ファイルを置く設定ディレクトリ: 候補のうち最初に存在するもの。どれも無ければ先頭。
// 一方が他方へのシンボリックリンクでも、存在する先頭の候補に決まるので置き場所は 1 つになる。
func PickConfigDir(names []string, base string, exists func(path string) bool) string {
	for _, name := range names {
		if exists(Join(base, name)) {
			return Join(base, name)
		}
	}
	first := ".claude"
	if len(names) > 0 {
		first = names[0]
	}
	return Join(base, first)
}

// ConfigPaths は base 直下の各候補に rel を付けたパス（存在は見ない）。
func ConfigPaths(io Io, base string, rel ...string) []string {
	names := io.ConfigDirNames()
	out := make([]string, len(names))
	for i, name := range names {
		out[i] = Join(append([]string{base, name}, rel...)...)
	}
	return out
}

// FindConfigPath は base/<候補>/rel のうち最初に存在するもの。
func FindConfigPath(io Io, base string, rel ...string) (string, bool) {
	for _, path := range ConfigPaths(io, base, rel...) {
		if io.Exists(path) {
			return path, true
		}
	}
	return "", false
}

// FindGateYaml はプロジェクトの gate.yaml（候補のうち最初に存在するもの）。base を省略すると projectDir（無ければ cwd）。
func FindGateYaml(io Io, base ...string) (string, bool) {
	b := io.ProjectDir()
	if b == "" {
		b = io.Cwd()
	}
	if len(base) > 0 {
		b = base[0]
	}
	return FindConfigPath(io, b, "gate.yaml")
}
