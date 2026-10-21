package hookgate

// gate の dogwood ポリシー評価（src/gate.ts の PolicyContext と、Gate の resolveDogwood / policyPaths / dogwoodVerdict）。

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// PolicyResolved は解決した policy / policy_schema / 既定ポリシーかどうか。
type PolicyResolved struct {
	Policy    string
	Schema    string
	IsDefault bool
}

// ResolveDogwood は dogwood バイナリのパス。DOGWOOD_BIN が指定されているときは PATH へ落ちない。見つからなければ ("", false)。
func (g *Gate) ResolveDogwood() (string, bool) {
	if explicit := g.Io.Env().DogwoodBin; explicit != "" {
		if g.Io.IsExecutable(explicit) {
			return explicit, true
		}
		return "", false
	}
	if found, ok := Which(g.Io, "dogwood"); ok {
		return found, true
	}
	for _, candidate := range gateDogwoodFallbacks {
		path := ExpandUser(candidate, g.Io.Env().Home)
		if g.Io.IsExecutable(path) {
			return path, true
		}
	}
	return "", false
}

// ResolvePolicyPath は policy / policy_schema の値を絶対パスにする（~ 展開、rootDir からの相対）。値が無ければ ""。
func (g *Gate) ResolvePolicyPath(rootDir string, value any) string {
	if !Truthy(value) {
		return ""
	}
	path := ExpandUser(Str(value), g.Io.Env().Home)
	if IsAbsolute(path) {
		return path
	}
	return Normpath(Join(rootDir, path))
}

// inheritedSetting は owner（rule / consistency_check）→ cfg（トップレベル）の順に、値ではなく「キーの有無」で設定値を選ぶ。
// false が無効化の指定なので真偽値では選べない。どちらにも無ければ (nil, false)。
func gateInheritedSetting(cfg, owner Dict, key string) (any, bool) {
	for _, src := range []Dict{owner, cfg} {
		if v, ok := src[key]; ok {
			return v, true
		}
	}
	return nil, false
}

// PolicyPaths は policy / policy_schema / 既定ポリシーかどうか を解決する。owner 側の指定がトップレベル（cfg）を上書きする。
// 未設定なら同梱の既定ポリシーを使い、false を指定した場合と、明示したファイルが存在しない場合は nil
// ＝ポリシー機構は無効で従来どおり実行する（明示指定の取りこぼしは設定ミスなので既定へフォールバック
// せずログに残す）。
func (g *Gate) PolicyPaths(cfg, owner Dict, rootDir string, logs *[]string) *PolicyResolved {
	value, found := gateInheritedSetting(cfg, owner, "policy")
	if value == false {
		return nil
	}
	isDefault := !found || value == nil
	policy := g.DefaultPolicy
	if !isDefault {
		policy = g.ResolvePolicyPath(rootDir, value)
	}
	if policy == "" || !g.Io.Exists(policy) {
		if !isDefault && policy != "" && logs != nil {
			*logs = append(*logs, g.T("gate.policyNotFound", map[string]any{"policy": policy}))
		}
		return nil
	}
	schemaValue := owner["policy_schema"]
	if !Truthy(schemaValue) {
		schemaValue = cfg["policy_schema"]
	}
	schema := g.ResolvePolicyPath(rootDir, schemaValue)
	if schema == "" {
		schema = g.DefaultPolicySchema
	}
	return &PolicyResolved{Policy: policy, Schema: schema, IsDefault: isDefault}
}

// DogwoodVerdict は今回のコマンドの verdict を dogwood replay で求め、(verdict, "") を返す。dogwood には単発の許可判定
// コマンドが無いので、root の実行履歴をトレースへ変換し、末尾に今回の request を足して頭から食わせ、最後の
// verdict を今回の判定として使う。評価できなかったときは ("", 理由) を返す。
func (g *Gate) DogwoodVerdict(policy, schema, rootDir, name, cmd string) (string, string) {
	binpath, ok := g.ResolveDogwood()
	if !ok {
		return "", g.T("dogwood.notFound")
	}
	history := g.ReadTrace(rootDir)
	lastTs := 0.0
	if len(history) > 0 {
		lastTs = gateNumber(history[len(history)-1]["ts"])
	}
	now := g.Io.Now()
	request := Dict{"ts": math.Max(math.Floor(float64(now)/1000), lastTs), "name": name, "cmd": cmd, "kind": "request"}
	project := Basename(Normpath(rootDir))
	if project == "" {
		project = "project"
	}
	tracefile := Join(g.StateDir, fmt.Sprintf(".dogwood-%d-%d.trace", now, gateNextLogSeq()))
	r := g.runDogwood(binpath, policy, schema, tracefile, project, append(history, request))
	if r.Error != "" || r.TimedOut {
		errText := r.Error
		if errText == "" {
			errText = "timed out"
		}
		return "", g.T("dogwood.runFailed", map[string]any{"error": errText})
	}
	if r.ExitCode != 0 {
		detail := r.Stderr
		if detail == "" {
			detail = r.Stdout
		}
		detail = gateJSSlice(strings.ReplaceAll(gateTrim(detail), "\n", " "), 0, 200)
		return "", g.T("dogwood.exited", map[string]any{"code": r.ExitCode, "detail": detail})
	}
	var parsed any
	if json.Unmarshal([]byte(r.Stdout), &parsed) != nil {
		return "", g.T("dogwood.badJson")
	}
	var verdicts []any
	if d, ok := AsDict(parsed); ok {
		verdicts, _ = d["verdicts"].([]any)
	}
	if len(verdicts) == 0 {
		return "", g.T("dogwood.noVerdict")
	}
	verdict := ""
	if last, ok := AsDict(verdicts[len(verdicts)-1]); ok {
		verdict = strings.ToLower(gateTruthyStr(last["verdict"]))
	}
	if verdict != "allow" && verdict != "deny" {
		return "", g.T("dogwood.badVerdict", map[string]any{"verdict": PyRepr(verdict)})
	}
	return verdict, ""
}

// runDogwood はトレースファイルを書いて dogwood replay を走らせ、トレースファイルは必ず消す。書けなければ panic（TS では例外）。
func (g *Gate) runDogwood(binpath, policy, schema, tracefile, project string, records []Dict) RunResult {
	defer g.rm(tracefile)
	var b strings.Builder
	for i, rec := range records {
		b.WriteString(TraceLine(rec, project, i) + "\n")
	}
	gateCheck(g.Io.WriteFile(tracefile, b.String()))
	return g.Io.Run([]string{binpath, "replay", policy, "--policy-schema", schema, "--trace", tracefile, "--format", "json"},
		RunOptions{TimeoutMs: POLICY_TIMEOUT * 1000})
}

// MakePolicyContext は rule / consistency_check のポリシー設定を解決する。無効なら nil を返し、呼び出し側は従来どおり無条件にコマンドを実行する。
func (g *Gate) MakePolicyContext(cfg, owner Dict, rootDir string, state *PolicyState, logs *[]string) *PolicyContext {
	if state == nil {
		return nil
	}
	resolved := g.PolicyPaths(cfg, owner, rootDir, logs)
	if resolved == nil {
		return nil
	}
	return &PolicyContext{gate: g, RootDir: rootDir, Policy: resolved.Policy, Schema: resolved.Schema, IsDefault: resolved.IsDefault, State: state}
}

// PolicyContext は rule / consistency_check 1つ分のポリシー設定。
type PolicyContext struct {
	gate      *Gate
	RootDir   string
	Policy    string
	Schema    string
	IsDefault bool
	State     *PolicyState
}

// Allows は判定して実行してよければ true。deny・評価不能ならスキップして控えへ積む。スキップは失敗ではないので、
// 呼び出し側は failed を立てない。ただし既定ポリシー（policy: 未設定）で dogwood 自体が入っていない環境では、
// 判定せず素通しする。ポリシーを設定した覚えの無い利用者の全コマンドが黙って止まるのを避けるため。
// dogwood が在るのに評価できない場合は素通ししない。
func (p *PolicyContext) Allows(label, cwd, cmd string, timeout float64, name string, logs *[]string, extraEnv GateEnv) bool {
	g := p.gate
	if p.IsDefault {
		if _, ok := g.ResolveDogwood(); !ok {
			return true
		}
	}
	pname := name
	if pname == "" {
		pname = Slug(cmd)
	}
	verdict, reason := g.DogwoodVerdict(p.Policy, p.Schema, p.RootDir, pname, cmd)
	if verdict == "" {
		*logs = append(*logs, g.T("gate.policyUnevaluated", map[string]any{"label": label, "reason": reason, "cmd": cmd}))
	} else {
		g.AppendTrace(p.RootDir, cwd, pname, cmd, "request")
		if verdict == "allow" {
			g.UndeferCmd(p.RootDir, cwd, cmd)
			p.State.Executed = true
			p.State.AllowedThisRun[gateDeferKeyOf(p.RootDir, cwd, cmd)] = true
			return true
		}
		*logs = append(*logs, g.T("gate.policySkipped", map[string]any{"label": label, "cmd": cmd}))
	}
	detail := g.T("gate.notePolicySkipped")
	if verdict == "" {
		detail = g.T("gate.notePolicyUnevaluated", map[string]any{"reason": reason})
	}
	g.Note("skip", label, cmd, detail)
	p.State.DeferredThisRun[gateDeferKeyOf(p.RootDir, cwd, cmd)] = true
	g.DeferCmd(p.RootDir, cwd, pname, cmd, timeout, label, extraEnv)
	return false
}

// Record は実行結果を実行履歴に積む。
func (p *PolicyContext) Record(cwd, cmd, name string, ok bool) {
	if name == "" {
		name = Slug(cmd)
	}
	kind := "error"
	if ok {
		kind = "response"
	}
	p.gate.AppendTrace(p.RootDir, cwd, name, cmd, kind)
}
