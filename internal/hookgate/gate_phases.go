package hookgate

// gate の rules フェーズ / checks フェーズと、エントリポイント RunGate（src/gate.ts の runRules 以降）。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"runtime/debug"
	"slices"
	"strings"
)

// ---- 予約（PENDING）。{ root: { check名: [raw, ...] } } を、JS のオブジェクトと同じくキーの挿入順を保って扱う ----

type gateRootChecks struct {
	names []string
	files map[string][]string
}

type gatePending struct {
	roots  []string
	checks map[string]*gateRootChecks
}

func newGatePending() *gatePending { return &gatePending{checks: map[string]*gateRootChecks{}} }

func (p *gatePending) empty() bool { return len(p.roots) == 0 }

// root の予約を返す（無ければ作る）。
func (p *gatePending) root(root string) *gateRootChecks {
	rc, ok := p.checks[root]
	if !ok {
		rc = &gateRootChecks{files: map[string][]string{}}
		p.checks[root] = rc
		p.roots = append(p.roots, root)
	}
	return rc
}

func (rc *gateRootChecks) set(name string, raws []string) {
	if _, ok := rc.files[name]; !ok {
		rc.names = append(rc.names, name)
	}
	rc.files[name] = raws
}

// allRaws はすべての予約が参照する元表記。
func (p *gatePending) allRaws() []string {
	var out []string
	for _, root := range p.roots {
		rc := p.checks[root]
		for _, name := range rc.names {
			out = append(out, rc.files[name]...)
		}
	}
	return out
}

func (p *gatePending) toOMap() OMap {
	m := OMap{}
	for _, root := range p.roots {
		rc := p.checks[root]
		inner := OMap{}
		for _, name := range rc.names {
			raws := rc.files[name]
			if raws == nil {
				raws = []string{}
			}
			inner = append(inner, KV{name, raws})
		}
		m = append(m, KV{root, inner})
	}
	return m
}

// gateOrderedObject は JSON のオブジェクトをキーの出現順つきで読む。オブジェクトでなければ ok=false。
func gateOrderedObject(raw []byte) ([]string, map[string]json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if delim, isDelim := tok.(json.Delim); err != nil || !isDelim || delim != '{' {
		return nil, nil, false
	}
	var keys []string
	vals := map[string]json.RawMessage{}
	for dec.More() {
		kt, err := dec.Token()
		key, isStr := kt.(string)
		if err != nil || !isStr {
			return nil, nil, false
		}
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return nil, nil, false
		}
		if _, dup := vals[key]; !dup {
			keys = append(keys, key)
		}
		vals[key] = v
	}
	return keys, vals, true
}

func (g *Gate) loadPending() *gatePending {
	out := newGatePending()
	text, ok := g.Io.ReadFile(g.Pending)
	if !ok || !json.Valid([]byte(text)) {
		return out
	}
	roots, vals, isObj := gateOrderedObject([]byte(text))
	if !isObj {
		return out
	}
	for _, root := range roots {
		rc := out.root(root)
		names, checks, isChecks := gateOrderedObject(vals[root])
		if !isChecks {
			continue
		}
		for _, name := range names {
			var raws []any
			_ = json.Unmarshal(checks[name], &raws)
			rc.set(name, gateStringList(raws))
		}
	}
	return out
}

func (g *Gate) savePending(data *gatePending) {
	if data.empty() {
		g.rm(g.Pending)
		return
	}
	gateCheck(g.Io.WriteFile(g.Pending, JSONStringify(data.toOMap())))
}

var gateAttemptsRe = regexp.MustCompile(`^[+-]?\d+$`)

// ---- rules フェーズ ----

// RulesResult は RunRules の結果。CheckNames はマッチしたルールが run_checks で参照した名前（出現順・重複排除）、CheckRefFiles は
// その名前ごとの参照元マッチファイル集合。
type RulesResult struct {
	Summary       []string
	Failed        bool
	SuccessFiles  map[string]bool
	FailFiles     map[string]bool
	CheckNames    []string
	CheckRefFiles map[string]map[string]bool
}

type gateTriggered struct {
	rule    Dict
	matched []string
	pairs   []PatternPair
}

// gateMatchPatterns は rule.match（`typeof m === 'string' ? [m] : truthy(m) ? m : []`）。文字列でもリストでもない真値は TypeError。
func gateMatchPatterns(m any) []string {
	if s, ok := m.(string); ok {
		return []string{s}
	}
	if !Truthy(m) {
		return nil
	}
	l, ok := m.([]any)
	if !ok {
		gateTypeErrorf("pats is not iterable")
	}
	var out []string
	for _, e := range l {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// noteUnmatchedFiles はどのルールにもマッチせず何も実行されなかったファイルを、スキップとして 1 行で残す。
func (g *Gate) noteUnmatchedFiles(rels []string, triggered []gateTriggered) {
	covered := map[string]bool{}
	for _, t := range triggered {
		for _, m := range t.matched {
			covered[m] = true
		}
	}
	var unmatched []string
	for _, r := range gateUniq(rels) {
		if !covered[r] {
			unmatched = append(unmatched, r)
		}
	}
	if len(unmatched) == 0 {
		return
	}
	unmatched = gateSorted(unmatched)
	shown := strings.Join(unmatched[:min(len(unmatched), gateUnmatchedShown)], ", ")
	more := ""
	if len(unmatched) > gateUnmatchedShown {
		more = g.T("gate.andMore", map[string]any{"n": len(unmatched) - gateUnmatchedShown})
	}
	g.mu.Lock()
	g.Status = append(g.Status, g.T("gate.skipUnmatched", map[string]any{"files": shown + more}))
	g.mu.Unlock()
}

func gateTimeoutOf(v any) float64 {
	if Truthy(v) {
		if f := jsNumber(v); !math.IsNaN(f) {
			return f
		}
	}
	return DEFAULT_TIMEOUT
}

// gateRuleRun は 1 ルール分の run の結果。
type gateRuleRun struct {
	summary []string
	failed  bool
	success []string
	fail    []string
}

// runRulePerFileDir は per_file_dir 付きのルール 1 つ分。
func (g *Gate) runRulePerFileDir(t gateTriggered, mode string, cmds []any, timeout float64, logs *[]string, rootDir string, policy *PolicyContext) gateRuleRun {
	var out gateRuleRun
	// mode == "file": マッチした各ファイル自身のディレクトリをルートに、
	// mode == "pattern_root": マッチしたパターンの最初の ** 直前をルートにし、
	// いずれもルート単位で重複排除して実行（ルート名の昇順）
	rootsByRel := ComputePerFileRoots(mode, t.pairs, t.matched)
	var dirs []string
	for _, d := range rootsByRel {
		dirs = append(dirs, d)
	}
	for _, d := range gateSorted(gateUniq(dirs)) {
		cwd := rootDir
		if d != "" {
			cwd = Join(rootDir, d)
		}
		label := d
		if label == "" {
			label = "."
		}
		var dirFiles []string
		for _, rp := range t.matched {
			if root, ok := rootsByRel[rp]; ok && root == d {
				dirFiles = append(dirFiles, rp)
			}
		}
		if !gateIsDir(g.Io, cwd) {
			*logs = append(*logs, g.T("gate.rootNoCwd", map[string]any{"label": label, "cwd": cwd}))
			out.summary = append(out.summary, fmt.Sprintf("(%s) %s  %s", label, SummarizeCmds(cmds), g.T("gate.skipNoCwd")))
			g.Note("skip", label, SummarizeCmds(cmds), g.T("gate.noteNoCwd"))
			continue
		}
		out.summary = append(out.summary, fmt.Sprintf("(%s) %s", label, SummarizeCmds(cmds)))
		if g.RunCmds(label, cmds, cwd, timeout, logs, policy, FilesEnv(dirFiles), rootDir) {
			out.failed = true
			out.fail = append(out.fail, dirFiles...)
		} else {
			out.success = append(out.success, dirFiles...)
		}
	}
	return out
}

// runRulePlain は per_file_dir の無いルール 1 つ分。
func (g *Gate) runRulePlain(t gateTriggered, cmds []any, timeout float64, logs *[]string, rootDir string, policy *PolicyContext) gateRuleRun {
	var out gateRuleRun
	cwd := rootDir
	if dir := t.rule["dir"]; Truthy(dir) {
		cwd = Join(rootDir, Str(dir))
	}
	label := "."
	if dir, has := t.rule["dir"]; has && dir != nil {
		label = Str(dir)
	}
	if !gateIsDir(g.Io, cwd) {
		*logs = append(*logs, g.T("gate.ruleNoCwd", map[string]any{"label": label, "cwd": cwd}))
		out.summary = append(out.summary, fmt.Sprintf("(%s) %s  %s", label, SummarizeCmds(cmds), g.T("gate.skipNoCwd")))
		g.Note("skip", label, SummarizeCmds(cmds), g.T("gate.noteNoCwd"))
		return out
	}
	out.summary = append(out.summary, fmt.Sprintf("(%s) %s", label, SummarizeCmds(cmds)))
	if g.RunCmds(label, cmds, cwd, timeout, logs, policy, FilesEnv(t.matched), rootDir) {
		out.failed = true
		out.fail = append(out.fail, t.matched...)
	} else {
		out.success = append(out.success, t.matched...)
	}
	return out
}

// RunRules は rels に対してマッチしたルールの run だけを実行する。consistency_checks には一切触れない。
func (g *Gate) RunRules(cfg Dict, rels []string, logs *[]string, rootDir string, policyState *PolicyState) RulesResult {
	var triggered []gateTriggered
	for _, r := range gateRulesOf(cfg) {
		rule := gateDictItem(r)
		pairs, err := MatchPatterns(gateMatchPatterns(rule["match"]))
		gateCheck(err)
		var hit []string
		for _, rp := range rels {
			for _, p := range pairs {
				if p.Rx.MatchString(rp) {
					hit = append(hit, rp)
					break
				}
			}
		}
		if matched := gateSorted(gateUniq(hit)); len(matched) > 0 {
			triggered = append(triggered, gateTriggered{rule: rule, matched: matched, pairs: pairs})
		}
	}

	res := RulesResult{
		Summary:       []string{},
		SuccessFiles:  map[string]bool{},
		FailFiles:     map[string]bool{},
		CheckNames:    []string{},
		CheckRefFiles: map[string]map[string]bool{},
	}
	for _, t := range triggered {
		cmds := gateListOf(t.rule, "run")
		timeout := gateTimeoutOf(t.rule["timeout"])
		policy := g.MakePolicyContext(cfg, t.rule, rootDir, policyState, logs)
		for _, n := range gateListOf(t.rule, "run_checks") {
			name := Str(n)
			set, ok := res.CheckRefFiles[name]
			if !ok {
				set = map[string]bool{}
				res.CheckRefFiles[name] = set
			}
			for _, f := range t.matched {
				set[f] = true
			}
			if !slices.Contains(res.CheckNames, name) {
				res.CheckNames = append(res.CheckNames, name)
			}
		}
		var run gateRuleRun
		if raw := t.rule["per_file_dir"]; Truthy(raw) {
			mode := NormalizePerFileDirMode(raw)
			if mode == "" {
				*logs = append(*logs, g.T("gate.badPerFileDir", map[string]any{"value": PyRepr(raw)}))
				res.Summary = append(res.Summary, SummarizeCmds(cmds)+"  "+g.T("gate.skipBadPerFileDir"))
				res.Failed = true
				for _, f := range t.matched {
					res.FailFiles[f] = true
				}
				continue
			}
			run = g.runRulePerFileDir(t, mode, cmds, timeout, logs, rootDir, policy)
		} else {
			run = g.runRulePlain(t, cmds, timeout, logs, rootDir, policy)
		}
		res.Summary = append(res.Summary, run.summary...)
		if run.failed {
			res.Failed = true
		}
		for _, f := range run.fail {
			res.FailFiles[f] = true
		}
		for _, f := range run.success {
			res.SuccessFiles[f] = true
		}
	}

	g.noteUnmatchedFiles(rels, triggered)
	return res
}

// gateAllRoots は RunRules を root ごとに実行した結果を、キー (root, rel) 単位にまとめたもの。
type gateAllRoots struct {
	summary            []string
	failed             bool
	successKeys        map[string]bool
	failKeys           map[string]bool
	consumedKeys       map[string]bool
	checkRoots         []string // checkNamesByRoot の挿入順
	checkNamesByRoot   map[string][]string
	checkRefKeysByRoot map[string]map[string]map[string]bool
}

// runRulesAllRoots は root ごとに RunRules を実行し、結果をキー (root, rel) 単位にまとめて返す。
func (g *Gate) runRulesAllRoots(rootOrder []string, relsByRoot map[string][]string, mainCfg Dict, logs *[]string, policyState *PolicyState) *gateAllRoots {
	res := &gateAllRoots{
		summary: []string{}, successKeys: map[string]bool{}, failKeys: map[string]bool{}, consumedKeys: map[string]bool{},
		checkNamesByRoot: map[string][]string{}, checkRefKeysByRoot: map[string]map[string]map[string]bool{},
	}
	for _, root := range rootOrder {
		rels := relsByRoot[root]
		if len(rels) == 0 {
			continue
		}
		if root != g.ProjectDir && !gateIsDir(g.Io, root) {
			*logs = append(*logs, g.T("gate.worktreeNotFound", map[string]any{"root": root}))
			for _, rp := range rels {
				res.consumedKeys[gateKey(root, rp)] = true
			}
			continue
		}
		cfg := mainCfg
		prefix := ""
		if root != g.ProjectDir {
			cfg = g.loadRootCfg(root, mainCfg)
			prefix = "[" + Relpath(root, g.ProjectDir) + "] "
		}
		r := g.RunRules(cfg, rels, logs, root, policyState)
		for _, s := range r.Summary {
			res.summary = append(res.summary, prefix+s)
		}
		if r.Failed {
			res.failed = true
		}
		for rp := range r.SuccessFiles {
			res.successKeys[gateKey(root, rp)] = true
		}
		for rp := range r.FailFiles {
			res.failKeys[gateKey(root, rp)] = true
		}
		if len(r.CheckNames) > 0 {
			res.checkRoots = append(res.checkRoots, root)
			res.checkNamesByRoot[root] = r.CheckNames
			refs := map[string]map[string]bool{}
			for name, files := range r.CheckRefFiles {
				keys := map[string]bool{}
				for rp := range files {
					keys[gateKey(root, rp)] = true
				}
				refs[name] = keys
			}
			res.checkRefKeysByRoot[root] = refs
		}
	}
	return res
}

// mergePendingChecks は rules フェーズで新たに参照された consistency_checks の予約を、ルートごとに既存の予約とユニオンして永続化する。
func (g *Gate) mergePendingChecks(res *gateAllRoots, rawByKey map[string]string) {
	if len(res.checkRoots) == 0 {
		return
	}
	data := g.loadPending()
	for _, root := range res.checkRoots {
		rootChecks := data.root(root)
		ref := res.checkRefKeysByRoot[root]
		for _, name := range res.checkNamesByRoot[root] {
			var raws []string
			for k := range ref[name] {
				raws = append(raws, rawByKey[k])
			}
			rootChecks.set(name, gateSorted(gateUniq(rootChecks.files[name], raws)))
		}
	}
	g.savePending(data)
}

// applyRulesResult は runRulesAllRoots の結果を状態ファイルへ反映する。keys は今回 rules を走らせたキー。
//   - CHANGED: keys のうち、通らなかった（失敗・未判定の）ものだけを残す。keys 以外の行はそのまま。
//   - SIDECAR: 通ったキーのうち run_checks で参照されたものを、checks フェーズの確認待ちとして足す。
//   - PENDING: 参照された consistency_checks の予約を足す。
//   - FAILED: keys のうち失敗したものを足し、それ以外（通った・消えた・どのルールにも当たらない）は外す。
//     checks フェーズはこれを見て、直っていないファイルの rules を最新の内容で再実行する。
func (g *Gate) applyRulesResult(keys []string, rawByKey map[string]string, res *gateAllRoots) {
	if len(res.checkRoots) > 0 {
		g.mergePendingChecks(res, rawByKey)
	}

	// run_checks を参照したキーだけ checks フェーズの確認待ちとして SIDECAR へ退避する。run_checks を持たない
	// ルールで通ったキーは、それ以上待つものが無いので CHANGED からも SIDECAR からも完全に手を離す。
	checkedKeys := map[string]bool{}
	for _, ref := range res.checkRefKeysByRoot {
		for _, ks := range ref {
			for k := range ks {
				checkedKeys[k] = true
			}
		}
	}

	var remaining, sidecarAdd []string
	seen, seenSidecar := map[string]bool{}, map[string]bool{}
	for _, k := range keys {
		if res.consumedKeys[k] {
			continue
		}
		if res.successKeys[k] && !res.failKeys[k] {
			if checkedKeys[k] && !seenSidecar[k] {
				seenSidecar[k] = true
				sidecarAdd = append(sidecarAdd, k)
			}
			continue
		}
		if seen[k] {
			continue
		}
		seen[k] = true
		remaining = append(remaining, k)
	}
	ran := gateSetOf(keys)
	notRan := func(order []string) []string {
		var out []string
		for _, k := range order {
			if !ran[k] {
				out = append(out, k)
			}
		}
		return out
	}
	changed := g.loadChangedFlat(g.Changed)
	g.writeChangedFlat(g.Changed, gateUniq(notRan(changed.order), remaining), gateMergeMaps(changed.rawByKey, rawByKey))

	if len(sidecarAdd) > 0 {
		existing := g.loadChangedFlat(g.Sidecar)
		g.writeChangedFlat(g.Sidecar, gateUniq(existing.order, sidecarAdd), gateMergeMaps(existing.rawByKey, rawByKey))
	}

	var failedNow []string
	for _, k := range keys {
		if res.failKeys[k] && !res.consumedKeys[k] {
			failedNow = append(failedNow, k)
		}
	}
	prev := g.loadChangedFlat(g.Failed)
	g.writeChangedFlat(g.Failed, gateUniq(notRan(prev.order), failedNow), gateMergeMaps(prev.rawByKey, rawByKey))
}

func (g *Gate) runRulesPhase() int {
	if !g.Io.Exists(g.Action) || !g.Io.Exists(g.Changed) {
		return 0
	}
	changed := g.loadChangedFlat(g.Changed)
	if len(changed.order) == 0 {
		g.rm(g.Changed)
		return 0
	}

	cfg := g.LoadAction(g.Action)
	if len(gateRulesOf(cfg)) == 0 {
		g.rm(g.Changed)
		return 0
	}

	logs := []string{}
	policyState := NewPolicyState()
	keysBeforeThisRun := g.DeferredKeys()
	groups := gateGroupKeysByRoot(changed.order)
	res := g.runRulesAllRoots(groups.order, groups.relsByRoot, cfg, &logs, policyState)
	summary := res.summary
	failed := res.failed

	// ポリシー判定を通って実際に実行されたコマンドがあった回にだけ控えを消化する。消化するのはこの回が
	// 始まる前から控えにあった分だけ。この回の中で新しく積まれた分は次回以降に回す（間引きを1回分は
	// 効かせるため）。控えの失敗は failed には数えるが、元の match ファイル集合とは切れているので
	// success / fail のキーには影響させない。
	if policyState.Executed {
		keysToDrain := map[string]bool{}
		for k := range keysBeforeThisRun {
			if !policyState.DeferredThisRun[k] {
				keysToDrain[k] = true
			}
		}
		deferredSummary, deferredFailed := g.RunDeferred(g.TakeDeferredMatching(keysToDrain), &logs)
		summary = append(summary, deferredSummary...)
		if len(deferredFailed) > 0 {
			failed = true
		}
	}

	g.applyRulesResult(changed.order, changed.rawByKey, res)

	if failed {
		g.writeErr(strings.Join(append(append([]string{}, g.Status...), logs...), "\n") + "\n")
		g.writeErr(g.T("gate.rulesFailed") + "\n")
		return 2
	}
	if len(summary) > 0 || len(g.Status) > 0 {
		ok := make([]string, len(summary))
		for i, s := range summary {
			ok[i] = "✓ " + s
		}
		body := g.StatusBlock(strings.Join(ok, "\n"))
		g.print(OMap{{"systemMessage", g.T("gate.rulesPassed", map[string]any{"body": body})}})
	}
	return 0
}

// ---- checks フェーズ ----

// runNamedChecks は予約された consistency_checks の名前だけを実行する。定義が見つからない／cwd が無いものはスキップ扱い（失敗にはしない）。
func (g *Gate) runNamedChecks(checksByName map[string]Dict, names []string, logs *[]string, rootDir string, cfg Dict, policyState *PolicyState, filesByName map[string][]string) ([]string, bool) {
	summary := []string{}
	failed := false
	for _, name := range gateSorted(names) {
		check, found := checksByName[name]
		if !found {
			*logs = append(*logs, g.T("gate.checkNotFound", map[string]any{"name": name}))
			summary = append(summary, g.T("gate.checkNotFoundSummary", map[string]any{"name": name}))
			g.mu.Lock()
			g.Status = append(g.Status, g.T("gate.skipCheckUndefined", map[string]any{"name": name}))
			g.mu.Unlock()
			continue
		}
		cwd := rootDir
		if dir := check["dir"]; Truthy(dir) {
			cwd = Join(rootDir, Str(dir))
		}
		cmds := gateListOf(check, "run")
		timeout := gateTimeoutOf(check["timeout"])
		if !gateIsDir(g.Io, cwd) {
			*logs = append(*logs, g.T("gate.checkNoCwd", map[string]any{"name": name, "cwd": cwd}))
			summary = append(summary, fmt.Sprintf("(check:%s) %s  %s", name, SummarizeCmds(cmds), g.T("gate.skipNoCwd")))
			g.Note("skip", "check:"+name, SummarizeCmds(cmds), g.T("gate.noteNoCwd"))
			continue
		}
		summary = append(summary, fmt.Sprintf("(check:%s) %s", name, SummarizeCmds(cmds)))
		policy := g.MakePolicyContext(cfg, check, rootDir, policyState, logs)
		var rels []string
		for _, raw := range filesByName[name] {
			_, rel := g.SplitRoot(raw)
			rels = append(rels, rel)
		}
		if g.RunCmds("check:"+name, cmds, cwd, timeout, logs, policy, FilesEnv(rels), rootDir) {
			failed = true
		}
	}
	return summary, failed
}

// pendingRefKeys は pending から参照されている全キーを返す。
func (g *Gate) pendingRefKeys(pending *gatePending) map[string]bool {
	keys := map[string]bool{}
	for _, raw := range pending.allRaws() {
		keys[gateKey(g.SplitRoot(raw))] = true
	}
	return keys
}

func (g *Gate) pendingRawByKey(pending *gatePending) map[string]string {
	m := map[string]string{}
	for _, raw := range pending.allRaws() {
		k := gateKey(g.SplitRoot(raw))
		if _, ok := m[k]; !ok {
			m[k] = raw
		}
	}
	return m
}

// confirmPending は予約された consistency_checks が全て成功したとき、対応するキーを SIDECAR から確定除去する。
func (g *Gate) confirmPending(pending *gatePending) {
	keys := g.pendingRefKeys(pending)
	if len(keys) == 0 {
		return
	}
	sidecar := g.loadChangedFlat(g.Sidecar)
	var kept []string
	for _, k := range sidecar.order {
		if !keys[k] {
			kept = append(kept, k)
		}
	}
	g.writeChangedFlat(g.Sidecar, kept, sidecar.rawByKey)
}

// requeuePendingToChanged は consistency_checks の確認を諦めたとき、対応するキーを SIDECAR から取り除き CHANGED へ戻す。
func (g *Gate) requeuePendingToChanged(pending *gatePending) {
	keys := g.pendingRefKeys(pending)
	if len(keys) == 0 {
		return
	}
	sidecar := g.loadChangedFlat(g.Sidecar)
	var keptSidecar []string
	for _, k := range sidecar.order {
		if !keys[k] {
			keptSidecar = append(keptSidecar, k)
		}
	}
	g.writeChangedFlat(g.Sidecar, keptSidecar, sidecar.rawByKey)

	changed := g.loadChangedFlat(g.Changed)
	rawLookup := gateMergeMaps(g.pendingRawByKey(pending), sidecar.rawByKey, changed.rawByKey)
	have := gateSetOf(changed.order)
	var missing []string
	for k := range keys {
		if !have[k] {
			missing = append(missing, k)
		}
	}
	g.writeChangedFlat(g.Changed, gateUniq(changed.order, gateSorted(missing)), rawLookup)
}

// purgeRootsFromSidecar は worktree が既に消えているルート分の予約は、SIDECAR からも静かに落とす。
func (g *Gate) purgeRootsFromSidecar(droppedRoots map[string]bool) {
	if len(droppedRoots) == 0 {
		return
	}
	sidecar := g.loadChangedFlat(g.Sidecar)
	var kept []string
	for _, k := range sidecar.order {
		if root, _ := gateUnkey(k); !droppedRoots[root] {
			kept = append(kept, k)
		}
	}
	g.writeChangedFlat(g.Sidecar, kept, sidecar.rawByKey)
}

// gateChecksByName は cfg.consistency_checks を名前で引けるようにする（同名は後勝ち）。
func gateChecksByName(cfg Dict) map[string]Dict {
	out := map[string]Dict{}
	for _, c := range gateListOf(cfg, "consistency_checks") {
		check := gateDictItem(c)
		if name, ok := check["name"].(string); ok {
			out[name] = check
		}
	}
	return out
}

// runPendingChecks は予約（pending）の root ごとに consistency_checks を実行する。worktree が消えているルートは落とす。
func (g *Gate) runPendingChecks(pending *gatePending, mainCfg Dict, logs *[]string, policyState *PolicyState) (*gatePending, map[string]bool, []string, bool) {
	activePending := newGatePending()
	droppedRoots := map[string]bool{}
	summary := []string{}
	failed := false
	for _, root := range pending.roots {
		checksMap := pending.checks[root]
		if root != g.ProjectDir && !gateIsDir(g.Io, root) {
			*logs = append(*logs, g.T("gate.worktreeNotFound", map[string]any{"root": root}))
			droppedRoots[root] = true
			continue
		}
		active := activePending.root(root)
		for _, name := range checksMap.names {
			active.set(name, checksMap.files[name])
		}
		cfg := mainCfg
		prefix := ""
		if root != g.ProjectDir {
			cfg = g.loadRootCfg(root, mainCfg)
			prefix = "[" + Relpath(root, g.ProjectDir) + "] "
		}
		rSummary, rFailed := g.runNamedChecks(gateChecksByName(cfg), checksMap.names, logs, root, cfg, policyState, checksMap.files)
		for _, s := range rSummary {
			summary = append(summary, prefix+s)
		}
		if rFailed {
			failed = true
		}
	}
	return activePending, droppedRoots, summary, failed
}

func gateCheckMarks(summary []string, mark string) string {
	out := make([]string, len(summary))
	for i, s := range summary {
		out[i] = mark + " " + s
	}
	return strings.Join(out, "\n")
}

// checksSucceeded は checks フェーズが全部通ったときの後始末と出力。終了コードを返す。
func (g *Gate) checksSucceeded(mainCfg Dict, pending, activePending *gatePending, failedFiles gateChangedFlat, summary []string) int {
	g.confirmPending(activePending)
	g.Cleanup([]string{g.Count, g.Pending})
	nothing := g.T("gate.nothingToRun")
	if len(summary) > 0 {
		nothing = gateCheckMarks(summary, "✓")
	}
	body := g.StatusBlock(nothing)
	if len(g.executedLabels) > 0 && !g.StopHookActive && mainCfg["report_success"] != false {
		// 失敗ブロック後の続きではない（stop_hook_active でない）ときだけ、成功をエージェントへ 1 回届ける。
		gateCheck(g.Io.WriteFile(g.Reported, "1\n"))
		marked := make([]string, len(g.executedLabels))
		for i, l := range g.executedLabels {
			marked[i] = l + " ✓"
		}
		labels := strings.Join(marked, " / ")
		reason := g.T("gate.allPassed", map[string]any{"labels": labels})
		g.setReport(g.T("gate.passedReport", map[string]any{"labels": labels}))
		g.writeErr(reason + "\n")
		g.print(OMap{{"decision", "block"}, {"reason", reason}})
		return 2
	}
	title := g.T("gate.deferredTitle")
	if !pending.empty() {
		title = "consistency checks"
	} else if len(failedFiles.order) > 0 {
		title = "rules"
	}
	g.setReport(g.T("gate.checksPassed", map[string]any{"title": title, "body": body}))
	g.print(OMap{{"systemMessage", g.Report}})
	return 0
}

// checksFailed は checks フェーズが失敗したときの試行回数の管理と出力。終了コードを返す。
func (g *Gate) checksFailed(activePending *gatePending, summary, logs []string) int {
	g.writeErr(strings.Join(append(append([]string{}, g.Status...), logs...), "\n") + "\n")

	attempts := 0
	if countText, ok := g.Io.ReadFile(g.Count); ok && gateAttemptsRe.MatchString(gateTrim(countText)) {
		attempts = ToCount(gateTrim(countText))
	}
	// 前回の Stop hook がブロックして継続させた結果の Stop ではない = 新しいユーザーターン起点の Stop なので、リトライ回数を数え直す。
	if !g.StopHookActive {
		attempts = 0
	}
	attempts++
	gateCheck(g.Io.WriteFile(g.Count, fmt.Sprint(attempts)))

	if attempts >= MAX_ATTEMPTS {
		// 諦めたら FAILED も手放す（毎回の Stop をブロックし続けないため）。失敗したファイルは CHANGED に残っているので、
		// 次の編集で rules フェーズが再び拾う。
		g.requeuePendingToChanged(activePending)
		g.Cleanup([]string{g.Count, g.Pending, g.Failed})
		g.writeErr(g.T("gate.checksGaveUpStderr", map[string]any{"max": MAX_ATTEMPTS}) + "\n")
		msg := g.T("gate.checksGaveUp", map[string]any{"max": MAX_ATTEMPTS}) + "\n" + gateCheckMarks(summary, "✗") + g.WithDetails("")
		g.setReport(msg)
		g.print(OMap{{"systemMessage", msg}})
		return 0
	}

	reason := g.T("gate.checksFailed", map[string]any{"attempt": attempts, "max": MAX_ATTEMPTS}) + "\n" + gateCheckMarks(summary, "✗") + g.WithDetails("")
	g.writeErr(reason + "\n")
	g.setReport(reason)
	// stdout が空だと harness 側の判定で exit 2 が non-blocking 扱いになる不具合があるため、stderr の内容に関わらず必ず JSON を出す。
	g.print(OMap{{"decision", "block"}, {"reason", reason}})
	return 2
}

func (g *Gate) runChecksPhase() int {
	// 成功報告でブロックした直後の Stop（stop_hook_active）は、報告の確認だけなので検証を走らせず通す。
	// 印は新しいユーザーターン起点の Stop でも消す（古い印が後の継続 Stop を素通しさせないように）。
	if g.Io.Exists(g.Reported) {
		g.rm(g.Reported)
		if g.StopHookActive {
			g.ReportConsumed = true
			return 0
		}
	}
	failedFiles := g.loadChangedFlat(g.Failed)
	if len(failedFiles.order) == 0 {
		g.rm(g.Failed)
	}
	if len(failedFiles.order) == 0 && !g.Io.Exists(g.Pending) && !g.Io.Exists(g.Deferred) {
		return 0
	}

	mainCfg := g.LoadAction(g.Action)

	logs := []string{}
	summary := []string{}
	failed := false
	policyState := NewPolicyState()

	// rules フェーズで失敗したまま直っていないファイルは、最新の内容で rules をもう一度走らせる。直っていれば
	// 通常どおり CHANGED / SIDECAR / PENDING へ振り分け（ここで予約された check も下で走る）、まだ失敗なら
	// 停止をブロックする。直さずに終了・完了報告できてしまうのを防ぐため。
	if len(failedFiles.order) > 0 {
		groups := gateGroupKeysByRoot(failedFiles.order)
		res := g.runRulesAllRoots(groups.order, groups.relsByRoot, mainCfg, &logs, policyState)
		summary = append(summary, res.summary...)
		if res.failed {
			failed = true
		}
		g.applyRulesResult(failedFiles.order, failedFiles.rawByKey, res)
	}

	pending := newGatePending()
	if g.Io.Exists(g.Pending) {
		pending = g.loadPending()
	}
	if pending.empty() {
		g.rm(g.Pending)
	}
	// rules フェーズの控えは、そこで実行が起きた回にしか消化されない。編集が止まると残り続け、未検証のまま
	// commit / 終了してしまうので、checks フェーズでも全件消化する。
	deferred := g.TakeDeferred()
	if len(failedFiles.order) == 0 && pending.empty() && len(deferred) == 0 {
		return 0
	}
	activePending, droppedRoots, pSummary, pFailed := g.runPendingChecks(pending, mainCfg, &logs, policyState)
	summary = append(summary, pSummary...)
	if pFailed {
		failed = true
	}

	g.purgeRootsFromSidecar(droppedRoots)

	// 予約チェックが実行した（または共有で結果を受け取った）コマンドは、ポリシーの有無にかかわらず、控えに同じものが
	// あっても消化済みとして扱う（同じフェーズで二重に走らせない）。
	var remaining []Dict
	g.mu.Lock()
	for _, e := range deferred {
		if !g.ranThisRun[gateDeferKey(e)] {
			remaining = append(remaining, e)
		}
	}
	g.mu.Unlock()
	dSummary, dFailed := g.RunDeferred(remaining, &logs)
	summary = append(summary, dSummary...)
	if len(dFailed) > 0 {
		g.RequeueDeferred(dFailed)
		failed = true
	}

	if !failed {
		return g.checksSucceeded(mainCfg, pending, activePending, failedFiles, summary)
	}
	return g.checksFailed(activePending, summary, logs)
}

// Main は gate の本体。終了コードを返す。
func (g *Gate) Main() int {
	g.PruneLogs()
	action, ok := FindGateYaml(g.Io, g.ProjectDir)
	if !ok {
		if yml, found := FindConfigPath(g.Io, g.ProjectDir, "gate.yml"); found {
			g.print(OMap{{"systemMessage", g.T("gate.ymlTypo", map[string]any{"path": yml})}})
		}
		g.Cleanup(nil)
		return 0
	}
	g.Action = action
	if g.Phase == "rules" {
		return g.runRulesPhase()
	}
	return g.runChecksPhase()
}

// RunGate は gate を1回実行する。内部エラーは握りつぶして作業を継続させる（stderr に詳細、systemMessage で通知）。
func RunGate(io Io, opts GateOptions) ScriptResult {
	g := NewGate(io, opts)
	exitCode := g.mainSafely()
	return ScriptResult{
		ExitCode:       exitCode,
		Stdout:         g.Stdout,
		Stderr:         g.Stderr,
		ReportConsumed: g.ReportConsumed,
		Report:         g.Report,
		HasReport:      g.HasReport,
	}
}

// mainSafely は Main の例外（panic）を内部エラーに変える。終わりに必ず FinishProgress を呼ぶ。
func (g *Gate) mainSafely() int {
	defer g.FinishProgress()
	exitCode := 0
	func() {
		defer func() {
			if r := recover(); r != nil {
				var msg string
				switch e := r.(type) {
				case error:
					msg = e.Error()
				case string:
					msg = e
				default:
					msg = fmt.Sprint(r)
				}
				g.Stderr += "[gate] internal error:\n" + msg + "\n" + string(debug.Stack()) + "\n"
				g.setReport(Tr(g.Io.Lang())("gate.internalError"))
				g.Stdout += JSONStringify(OMap{{"systemMessage", g.Report}}) + "\n"
				exitCode = 0
			}
		}()
		exitCode = g.Main()
	}()
	return exitCode
}
