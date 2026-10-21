package hookgate

// プロジェクトルート / worktree ルートの判定（gate と feedback ルールで共通）。

import "strings"

// Relativize は絶対パスを projectDir 相当からの相対パスにし、先頭の ./ を外す。
func Relativize(p, projectDir string) string {
	rp := p
	if IsAbsolute(p) {
		rp = Relpath(p, projectDir)
	}
	return strings.TrimPrefix(rp, "./")
}

// SplitRoot は path（絶対 or projectDir 相対）の実パスが <projectDir>/.claude/worktrees/<name>/ 配下なら
// (その worktree ルートの絶対パス, ルート相対パス) を、配下でなければ (projectDir, projectDir 相対パス) を返す。
func SplitRoot(projectDir, path string) (string, string) {
	worktreesDir := Normpath(Join(projectDir, ".claude", "worktrees"))
	var abs string
	if IsAbsolute(path) {
		abs = Normpath(path)
	} else {
		abs = Normpath(Join(projectDir, path))
	}
	relToWt := Relpath(abs, worktreesDir)
	if relToWt != "." && relToWt != ".." && !strings.HasPrefix(relToWt, "../") {
		name, rest, found := strings.Cut(relToWt, "/")
		if !found {
			rest = ""
		}
		return Normpath(Join(worktreesDir, name)), rest
	}
	return projectDir, Relativize(path, projectDir)
}

// RootLabel は label 用: ルートが projectDir ならそのまま、worktree なら "<worktree名>/<rel>"。
func RootLabel(root, projectDir, rel string) string {
	if root == projectDir {
		return rel
	}
	return Basename(root) + "/" + rel
}
