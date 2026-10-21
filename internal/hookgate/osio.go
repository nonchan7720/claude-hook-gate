package hookgate

// settings hook / Codex plugin の CLI 用: os と os/exec で Io を実装する。
// 画面に出す手段（Progress / Result / Redraw / Every）は持たない（no-op）。プロンプト上の帯は mod 側の ui.render が
// 実行中一覧のファイル（<設定ディレクトリ>/.gate-status/running/）を読んで描くので、一覧ファイルの読み書きは従来どおり行う。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func kindOf(m fs.FileMode) Kind {
	switch {
	case m.IsRegular():
		return KindFile
	case m.IsDir():
		return KindDir
	}
	return KindOther
}

// PickEnv は環境変数（名前→値）から、Io の EnvVars が使うものだけを拾う。
func PickEnv(environ map[string]string) EnvVars {
	return EnvVars{
		Home:              environ["HOME"],
		Path:              environ["PATH"],
		ClaudeFeedbackDir: environ["CLAUDE_FEEDBACK_DIR"],
		DogwoodBin:        environ["DOGWOOD_BIN"],
		TermProgram:       environ["TERM_PROGRAM"],
		CFBundleID:        environ["__CFBundleIdentifier"],
		FeedbackGateLang:  environ["FEEDBACK_GATE_LANG"],
		LCAll:             environ["LC_ALL"],
		LCMessages:        environ["LC_MESSAGES"],
		LangEnv:           environ["LANG"],
	}
}

// EnvironMap は現在のプロセスの環境変数を名前→値にする。
func EnvironMap() map[string]string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok && k != "" {
			m[k] = v
		}
	}
	return m
}

// BoolPtr は *bool を作る（OsIoInit.AutoCount 用）。
func BoolPtr(b bool) *bool { return &b }

// OsIoInit は MakeOsIo の引数。
type OsIoInit struct {
	// Environ は環境変数（CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT もここから読む）。
	Environ map[string]string
	// PayloadCwd は stdin JSON の cwd（CLAUDE_PROJECT_DIR が無いときの projectDir の代わり）。
	PayloadCwd string
	// Language はプラグイン設定 language（CLAUDE_PLUGIN_OPTION_language）。
	Language string
	// AutoCount が nil なら既定（true）。
	AutoCount *bool
	// AppName は通知の見出しに使うアプリ名。
	AppName string
	// ConfigDirNames は設定ディレクトリ名の候補。nil なら Claude Code のもの。
	ConfigDirNames []string
}

// PickConfigDirSync は候補のうち最初に存在するディレクトリ。無ければ先頭。
func PickConfigDirSync(names []string, base string) string {
	return PickConfigDir(names, base, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	})
}

// osIo は os / os/exec による Io。
type osIo struct {
	IoProps
}

// MakeOsIo は OS のファイルとプロセスに触れる Io を作る。
func MakeOsIo(init OsIoInit) Io {
	return newOsIo(init)
}

func newOsIo(init OsIoInit) *osIo {
	env := PickEnv(init.Environ)
	cwd := init.PayloadCwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	projectDir := init.Environ["CLAUDE_PROJECT_DIR"]
	if projectDir == "" {
		projectDir = cwd
	}
	names := init.ConfigDirNames
	if names == nil {
		names = ClaudeConfigDirs
	}
	pluginRoot := init.Environ["CLAUDE_PLUGIN_ROOT"]
	if pluginRoot == "" {
		pluginRoot, _ = os.Getwd()
	}
	homeBase := env.Home
	if homeBase == "" {
		homeBase = "~"
	}
	return &osIo{IoProps: IoProps{
		EnvVars:       env,
		Language:      ResolveLang(env, init.Language),
		NoAutoCount:   init.AutoCount != nil && !*init.AutoCount,
		Project:       projectDir,
		WorkDir:       cwd,
		Plugin:        pluginRoot,
		ConfigNames:   names,
		ProjectConfig: PickConfigDirSync(names, projectDir),
		HomeConfig:    PickConfigDirSync(names, homeBase),
		App:           init.AppName,
	}}
}

func (o *osIo) ReadFile(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.ToValidUTF8(string(b), "�"), true
}

func (o *osIo) WriteFile(path, text string) error {
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil { //nolint:gosec // TS 版と同じ既定の権限
		return err
	}
	return os.WriteFile(path, []byte(text), 0o644) //nolint:gosec // TS 版と同じ既定の権限
}

// dirOf は os.MkdirAll に渡す親ディレクトリ（POSIX の Dirname と同じ）。
func dirOf(p string) string {
	d := Dirname(p)
	if d == "" {
		return "."
	}
	return d
}

func (o *osIo) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (o *osIo) Stat(path string) (Stat, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return Stat{}, false
	}
	return Stat{Kind: kindOf(fi.Mode()), Size: fi.Size(), MtimeMs: fi.ModTime().UnixMilli()}, true
}

func (o *osIo) List(path string) []DirEntry {
	entries, err := os.ReadDir(path)
	if err != nil {
		return []DirEntry{}
	}
	out := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		fi, err := os.Lstat(Join(path, e.Name()))
		if err != nil {
			continue
		}
		var mtime int64
		if fi.Mode().IsRegular() {
			mtime = fi.ModTime().UnixMilli()
		}
		out = append(out, DirEntry{Name: e.Name(), Kind: kindOf(fi.Mode()), MtimeMs: mtime})
	}
	return out
}

func (o *osIo) IsExecutable(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return canExecute(path, fi)
}

func (o *osIo) RemoveFiles(paths []string) {
	for _, p := range paths {
		if fi, err := os.Lstat(p); err == nil && !fi.IsDir() {
			_ = os.Remove(p)
		}
	}
}

func (o *osIo) RemoveDir(path string) { removeEmptyDir(path) }

func (o *osIo) RemoveTree(path string) { _ = os.RemoveAll(path) }

func (o *osIo) Now() int64 { return time.Now().UnixMilli() }

func (o *osIo) Progress(string) {}

func (o *osIo) Result(string) {}

func (o *osIo) Redraw() {}

func (o *osIo) Every(int64, func()) func() { return func() {} }

// childEnv は子プロセスの環境: 現在の環境から CLAUDE_AGENT_ID を除き（サブエージェント経由で起動された場合に親の
// agent_id が漏れ込むと判定が環境依存になる）、extra を重ねる。
func childEnv(extra map[string]string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == "CLAUDE_AGENT_ID" {
			continue
		}
		if _, over := extra[k]; over {
			continue
		}
		env = append(env, kv)
	}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}

// lookPathIn は cmd を pathEnv（PATH の値）から探す。/ を含めばそのまま。node の spawn（libuv の execvp）と同じく
// 子の PATH だけで探すため、見つからなければ ok=false（親の PATH にはフォールバックしない）。
func lookPathIn(cmd, pathEnv string) (string, bool) {
	if strings.Contains(cmd, "/") {
		return cmd, true
	}
	for _, dir := range strings.Split(pathEnv, string(os.PathListSeparator)) {
		if dir == "" {
			dir = "."
		}
		p := Join(dir, cmd)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && canExecute(p, fi) {
			return p, true
		}
	}
	return cmd, false
}

// Run はシェルを介さず argv を実行する。独立したプロセスグループにして、TimeoutMs が指定されていれば
// タイムアウトで子孫ごと SIGKILL する（指定が無ければ hooks.json の timeout が上限になる）。
func (o *osIo) Run(argv []string, opts RunOptions) RunResult {
	return runProcess(argv, opts)
}

func runProcess(argv []string, opts RunOptions) RunResult {
	if len(argv) == 0 || argv[0] == "" {
		return RunResult{ExitCode: 1, Error: "empty argv"}
	}
	name := argv[0]
	if p, ok := opts.Env["PATH"]; ok {
		found, ok := lookPathIn(name, p)
		if !ok {
			// 子の PATH に無いコマンドは、親の PATH に有っても実行しない（node では ENOENT）
			return RunResult{ExitCode: 1, Error: fmt.Sprintf("exec: %q: executable file not found in $PATH", name)}
		}
		name = found
	}
	cmd := exec.CommandContext(context.Background(), name, argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = childEnv(opts.Env)
	cmd.Stdin = strings.NewReader(opts.Stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return RunResult{ExitCode: 1, Error: err.Error()}
	}
	var (
		mu       sync.Mutex
		timedOut bool
		timer    *time.Timer
	)
	if opts.TimeoutMs > 0 {
		timer = time.AfterFunc(time.Duration(opts.TimeoutMs)*time.Millisecond, func() {
			mu.Lock()
			timedOut = true
			mu.Unlock()
			killProcessGroup(cmd)
		})
	}
	waitErr := cmd.Wait()
	if timer != nil {
		timer.Stop()
	}
	mu.Lock()
	to := timedOut
	mu.Unlock()
	res := RunResult{
		Stdout:   strings.ToValidUTF8(stdout.String(), "�"),
		Stderr:   strings.ToValidUTF8(stderr.String(), "�"),
		TimedOut: to,
	}
	switch {
	case to:
		res.ExitCode = 1
	case waitErr == nil:
		res.ExitCode = 0
	default:
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() >= 0 {
			res.ExitCode = exitErr.ExitCode()
		} else {
			res.ExitCode = 1 // シグナルで終了
			if !errors.As(waitErr, &exitErr) {
				res.Error = waitErr.Error()
			}
		}
	}
	return res
}
