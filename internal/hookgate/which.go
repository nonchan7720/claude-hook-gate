package hookgate

import "strings"

// Which は PATH から実行可能なコマンドを探す（shutil.which / command -v 相当）。
func Which(io Io, name string) (string, bool) {
	if strings.Contains(name, "/") {
		if io.IsExecutable(name) {
			return name, true
		}
		return "", false
	}
	for _, dir := range strings.Split(io.Env().Path, ":") {
		if dir == "" {
			continue
		}
		candidate := Join(dir, name)
		if io.IsExecutable(candidate) {
			return candidate, true
		}
	}
	return "", false
}
