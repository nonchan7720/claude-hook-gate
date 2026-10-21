package hookgate

// Codex の apply_patch（tool_input.command がパッチ全文）を、ファイルごとの Edit / Write の tool_input に読み替える。
//
//   *** Begin Patch
//   *** Add File: path            → Write（content = + の行の全文）
//   *** Update File: path         → Edit（new_string = + の行）
//   *** Move to: new/path         （任意。検査は移動先のパスで行う）
//   *** Delete File: path         （検査しない）
//   *** End Patch

import "strings"

// PatchOp はパッチの操作。
type PatchOp string

// PatchOp の値。
const (
	PatchAdd    PatchOp = "add"
	PatchUpdate PatchOp = "update"
	PatchDelete PatchOp = "delete"
)

// PatchFile はパッチ内の 1 ファイル。MovedTo が空なら移動なし。
type PatchFile struct {
	Op      PatchOp
	Path    string
	MovedTo string
	Added   string
}

const (
	patchBegin = "*** Begin Patch"
	patchEnd   = "*** End Patch"
)

// PatchText は command のほか、古い形の input / patch も見て、パッチを含む文字列を返す。
func PatchText(toolInput any) string {
	d, ok := AsDict(toolInput)
	if !ok {
		return ""
	}
	for _, key := range []string{"command", "input", "patch"} {
		if s, ok := d[key].(string); ok && strings.Contains(s, patchBegin) {
			return s
		}
	}
	return ""
}

func patchHeader(line, prefix string) (string, bool) {
	if strings.HasPrefix(line, prefix) {
		return strings.TrimSpace(line[len(prefix):]), true
	}
	return "", false
}

// ParsePatch はパッチ全文をファイルごとに読む。パッチの形をしていなければ空。
func ParsePatch(text string) []PatchFile {
	begin := strings.Index(text, patchBegin)
	if begin < 0 {
		return []PatchFile{}
	}
	body := text[begin+len(patchBegin):]
	if end := strings.Index(body, patchEnd); end >= 0 {
		body = body[:end]
	}
	files := []PatchFile{}
	var current *PatchFile
	var added []string
	flush := func() {
		if current == nil {
			return
		}
		current.Added = strings.Join(added, "\n")
		files = append(files, *current)
		current = nil
		added = nil
	}
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if p, ok := patchHeader(line, "*** Add File:"); ok {
			flush()
			current = &PatchFile{Op: PatchAdd, Path: p}
		} else if p, ok := patchHeader(line, "*** Update File:"); ok {
			flush()
			current = &PatchFile{Op: PatchUpdate, Path: p}
		} else if p, ok := patchHeader(line, "*** Delete File:"); ok {
			flush()
			files = append(files, PatchFile{Op: PatchDelete, Path: p})
		} else if p, ok := patchHeader(line, "*** Move to:"); ok {
			if current != nil && current.Op == PatchUpdate && p != "" {
				current.MovedTo = p
			}
		} else if current != nil && strings.HasPrefix(line, "+") {
			added = append(added, line[1:])
		}
	}
	flush()
	return files
}

// AbsolutePath は相対パスを base 起点に、絶対パスはそのまま。
func AbsolutePath(p, base string) string {
	if IsAbsolute(p) {
		return p
	}
	return Join(base, p)
}

// PatchPayloads は共通のキー（session_id / cwd / tool_use_id / agent_id ...）は写し、tool_name と tool_input だけ差し替える。
func PatchPayloads(payload Dict, base string) []Dict {
	out := []Dict{}
	for _, f := range ParsePatch(PatchText(payload["tool_input"])) {
		if f.Op == PatchDelete {
			continue
		}
		target := f.Path
		if f.MovedTo != "" {
			target = f.MovedTo
		}
		filePath := AbsolutePath(target, base)
		var toolName string
		var toolInput Dict
		if f.Op == PatchAdd {
			toolName = "Write"
			toolInput = Dict{"file_path": filePath, "content": f.Added}
		} else {
			toolName = "Edit"
			toolInput = Dict{"file_path": filePath, "old_string": "", "new_string": f.Added}
		}
		p := make(Dict, len(payload)+2)
		for k, v := range payload {
			p[k] = v
		}
		p["tool_name"] = toolName
		p["tool_input"] = toolInput
		out = append(out, p)
	}
	return out
}
