// src/i18n.ts
var msg = (ja, en) => ({ ja, en });
var tr = (lang) => (m, ...a) => m[lang](...a);
var isLang = (v) => v === "ja" || v === "en";
function langOfLocale(locale) {
  const v = (locale ?? "").trim();
  if (v === "")
    return;
  return /^ja(?![a-z])/i.test(v) ? "ja" : "en";
}
function resolveLang(env, configured) {
  if (isLang(configured))
    return configured;
  if (isLang(env.FEEDBACK_GATE_LANG))
    return env.FEEDBACK_GATE_LANG;
  for (const v of [env.FEEDBACK_GATE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const lang = langOfLocale(v);
    if (lang)
      return lang;
  }
  return "en";
}

// src/io.ts
var ok = (stdout = "", stderr = "") => ({ exitCode: 0, stdout, stderr });

// src/messages.ts
var NOTIFY_WAITING = msg(() => "確認待ち", () => "Waiting for you");
var NOTIFY_WAITING_FALLBACK = msg(() => "確認を待っています", () => "Claude is waiting for your input");
var NOTIFY_DONE = msg(() => "完了", () => "Done");
var NOTIFY_DONE_FALLBACK = msg(() => "応答が完了しました", () => "The response has finished");
var INJECT_HEADER = msg(() => `# 確定フィードバックルール（count >= 3）
これらは繰り返し指摘された確定ルール。違反すると hook がブロックする。

`, () => `# Confirmed feedback rules (count >= 3)
These rules were pointed out repeatedly and are confirmed. A hook blocks violations.

`);
var INJECT_RULE_TITLE = msg((name, count) => `■ ${name} (これまで ${count} 回指摘されています)`, (name, count) => `■ ${name} (pointed out ${count} times so far)`);
var GUARD_EVALUATING = msg((rule) => `[feedback-guard] 評価中: ${rule}`, (rule) => `[feedback-guard] evaluating: ${rule}`);
var POST_EDIT_CHECKING = msg((rule, file) => `[feedback-post-edit] 検査中: ${rule} (${file})`, (rule, file) => `[feedback-post-edit] checking: ${rule} (${file})`);
var STOP_CHECK_CHECKING = msg((rule, file) => `[feedback-stop-check] 検査中: ${rule} (${file})`, (rule, file) => `[feedback-stop-check] checking: ${rule} (${file})`);
var STOP_CHECK_GAVE_UP = msg((max) => `[feedback-stop-check] ${max} 回連続でブロックしました。ループを打ち切ります。手動確認を。`, (max) => `[feedback-stop-check] Blocked ${max} times in a row. Giving up the loop; please check manually.`);
var STOP_CHECK_FIX_ABOVE = msg((attempt, max) => `[feedback-stop-check] 上記を修正してください（試行 ${attempt}/${max}）。`, (attempt, max) => `[feedback-stop-check] Fix the above (attempt ${attempt}/${max}).`);
var LAUNCH_CHECKLIST = msg(() => "--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件", () => "--- Check: what to do / background / current state of the code / what not to do / done criteria");
var LAUNCH_PROMPT_TO = msg((agentType) => `${agentType} に送るプロンプト:`, (agentType) => `Prompt to send to ${agentType}:`);
var LAUNCH_MESSAGE_TO = msg((recipient) => `${recipient} に送るメッセージ:`, (recipient) => `Message to send to ${recipient}:`);
var LAUNCH_UNKNOWN_RECIPIENT = msg(() => "宛先不明", () => "unknown recipient");
var CORRECT_DESCRIPTION = msg(() => "feedback ルールと違反ログを集計し、count の引き上げや enforce の追加を提案する", () => "Aggregate the feedback rules and the violation log, and propose count bumps and enforce additions");
var CORRECT_ENFORCE_TEMPLATE = msg(() => `enforce:
  - event: pre_bash
    when: '正規表現'
    unless: '正規表現'
    message: '違反時に出す指示文'
  - event: pre_edit
    path: 'glob'
    when: '正規表現'
    message: '違反時に出す指示文'
  - event: post_edit
    path: 'glob'
    when: '正規表現'
    message: '違反時に出す指示文'
  - event: stop_check
    changed: 'glob'
    check: 'shell cmd'
    message: '違反時に出す指示文'`, () => `enforce:
  - event: pre_bash
    when: 'regex'
    unless: 'regex'
    message: 'instruction shown on violation'
  - event: pre_edit
    path: 'glob'
    when: 'regex'
    message: 'instruction shown on violation'
  - event: post_edit
    path: 'glob'
    when: 'regex'
    message: 'instruction shown on violation'
  - event: stop_check
    changed: 'glob'
    check: 'shell cmd'
    message: 'instruction shown on violation'`);
var CORRECT_EXPIRED = msg((date) => `expires（${date}）を過ぎている`, (date) => `expires (${date}) has passed`);
var CORRECT_CONDITIONS = msg(() => "条件", () => "the conditions");
var CORRECT_NOT_MATCHING = msg((what) => `${what} がこのプロジェクトに一致せず無効`, (what) => `${what} do not match this project, so the rule is inactive`);
var CORRECT_TOP_DETAIL = msg((detail) => `。最多: ${detail}`, (detail) => `. Most frequent: ${detail}`);
var CORRECT_BUMP_TO_CONFIRMED = msg((window, n, counts, top) => `直近 ${window} で ${n} 回違反（${counts}）。確定ルールへ昇格${top}`, (window, n, counts, top) => `${n} violations in the last ${window} (${counts}). Promote to a confirmed rule${top}`);
var CORRECT_BUMP_TO_DENY = msg((window, strong, counts, top) => `直近 ${window} で ask / block が ${strong} 回（${counts}）。deny へ引き上げ${top}`, (window, strong, counts, top) => `ask / block ${strong} times in the last ${window} (${counts}). Raise to deny${top}`);
var CORRECT_NO_ENFORCE = msg((count) => `count ${count} の確定ルールだが enforce が無く、hook が検知できない（違反ログにも出ない）`, (count) => `Confirmed rule with count ${count} but no enforce, so no hook can detect it (and it never appears in the violation log)`);
var CORRECT_STALE = msg(() => "enforce ありで違反ログに一度も出ていない。enforce が効いているか、ルールが古くなっていないか確認", () => "Has enforce but has never appeared in the violation log. Check that the enforce works and that the rule is not out of date");
var CORRECT_EXPIRED_ACTION = msg((reason) => `${reason}。削除または更新を検討`, (reason) => `${reason}. Consider deleting or updating it`);
var CORRECT_REPORT_HEADER = msg((window, rules, violations) => `[correct] 直近 ${window}: ルール ${rules} 件 / 違反 ${violations} 件`, (window, rules, violations) => `[correct] last ${window}: ${rules} rules / ${violations} violations`);
var CORRECT_NO_PROPOSALS = msg(() => "提案はありません。", () => "No proposals.");
var CORRECT_APPLY_NONE = msg(() => "apply: 書き換えたファイルはありません。", () => "apply: no files were rewritten.");
var CORRECT_APPLY_DONE = msg(() => "apply: count を書き換えました。", () => "apply: count was rewritten.");
var CORRECT_APPLY_HINT = msg(() => "`/correct apply` で bump の count 引き上げをファイルに書き込みます（enforce は提案のみ）。", () => "`/correct apply` writes the count bumps of the bump proposals to the files (enforce is proposal only).");
var CORRECT_CONTEXT = msg(() => [
  "/correct の結果です。ユーザーに上記の提案を提示してください。",
  "- enforce の追加は、対象ルールの本文から正規表現 / glob を起こして具体案を提案する（雛形は rules/feedback_rules.md の enforce 節）。",
  "- ファイルを書き換える前に、必ずユーザーに確認する（rules/feedback_rules.md のルールどおり）。",
  "- stale / expired は、ルールを残すか更新・削除するかをユーザーに尋ねる。"
].join(`
`), () => [
  "This is the result of /correct. Present the proposals above to the user.",
  "- For an enforce addition, derive a regex / glob from the body of the rule and propose a concrete entry (template: the enforce section of rules/feedback_rules.md).",
  "- Always ask the user before rewriting any file (as the rules in rules/feedback_rules.md say).",
  "- For stale / expired, ask the user whether to keep, update or delete the rule."
].join(`
`));
var CORRECT_CONTEXT_APPLIED = msg((list) => `- apply により次のファイルの count をすでに書き換えた。その事実をユーザーに伝えること: ${list}`, (list) => `- apply has already rewritten count in the following files. Tell the user so: ${list}`);
var BAND_RUNNING = msg(() => "[gate] 実行中:", () => "[gate] running:");
var BAND_WAITING = msg(() => "待機中", () => "waiting");
var BAND_DONE = msg((counts, seconds) => `[gate] 完了: ${counts} (${seconds}s)`, (counts, seconds) => `[gate] done: ${counts} (${seconds}s)`);
var GATE_HEAD_OMITTED = msg((n) => `…（先頭 ${n} 行省略）`, (n) => `… (first ${n} lines omitted)`);
var GATE_REST_OMITTED = msg(() => "…（以降省略）", () => "… (rest omitted)");
var GATE_FAILURES_OMITTED = msg((n) => `…（残り ${n} 件の失敗は省略。各 [gate] log のパスを見てください）`, (n) => `… (${n} more failures omitted; see the [gate] log path of each)`);
var GATE_POLICY_NOT_FOUND = msg((policy) => `=== [gate] policy に指定されたファイルが見つかりません: ${policy}。ポリシー判定を行わず実行します。 ===`, (policy) => `=== [gate] The policy file was not found: ${policy}. Running without policy evaluation. ===`);
var DOGWOOD_NOT_FOUND = msg(() => "dogwood バイナリが見つかりません（DOGWOOD_BIN / PATH / ~/.cargo/bin を確認してください）", () => "dogwood binary not found (check DOGWOOD_BIN / PATH / ~/.cargo/bin)");
var DOGWOOD_RUN_FAILED = msg((error) => `dogwood の実行に失敗しました: ${error}`, (error) => `failed to run dogwood: ${error}`);
var DOGWOOD_EXITED = msg((code, detail) => `dogwood replay が異常終了しました（exit ${code}）: ${detail}`, (code, detail) => `dogwood replay exited abnormally (exit ${code}): ${detail}`);
var DOGWOOD_BAD_JSON = msg(() => "dogwood replay の出力を JSON として読めませんでした", () => "could not parse the output of dogwood replay as JSON");
var DOGWOOD_NO_VERDICT = msg(() => "dogwood replay が verdict を返しませんでした", () => "dogwood replay returned no verdict");
var DOGWOOD_BAD_VERDICT = msg((verdict) => `dogwood replay の verdict を解釈できませんでした: ${verdict}`, (verdict) => `could not interpret the verdict of dogwood replay: ${verdict}`);
var GATE_SHARED_RESULT = msg((logpath) => `[gate] 同じ実行が他のエージェントで走っていたため、その結果を受け取りました（実行側のログ: ${logpath}）`, (logpath) => `[gate] The same run was in progress in another agent, so its result was taken over (log of the running side: ${logpath})`);
var GATE_TIMEOUT = msg((seconds) => `[gate] タイムアウト（${seconds}秒）で強制終了しました。無限ループやハングの可能性があります。`, (seconds) => `[gate] Killed after the timeout (${seconds}s). The command may be in an infinite loop or hung.`);
var GATE_FAILED_OUTPUT_HEADER = msg(() => "--- 失敗したコマンドの出力 ---", () => "--- output of the failed commands ---");
var GATE_NESTED_PARALLEL = msg((label) => `=== [gate] (${label}) parallel の中に parallel はネストできません。失敗扱いにします。 ===`, (label) => `=== [gate] (${label}) parallel cannot be nested inside parallel. Treated as a failure. ===`);
var GATE_DEFERRED_NO_CWD = msg((label, cwd) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。この控えを破棄します。 ===`, (label, cwd) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Dropping this deferred entry. ===`);
var GATE_CANNOT_READ_YAML = msg((path) => `gate.yaml を読めません: ${path}`, (path) => `cannot read gate.yaml: ${path}`);
var GATE_AND_MORE = msg((n) => ` ほか${n}件`, (n) => ` and ${n} more`);
var GATE_SKIP_UNMATCHED = msg((files) => `[gate] skip: ${files} (どのルールにもマッチしません)`, (files) => `[gate] skip: ${files} (matches no rule)`);
var GATE_BAD_PER_FILE_DIR = msg((value) => `=== [gate] per_file_dir の値が不正です: ${value}（true / "file" / "pattern_root" のいずれかを指定してください）。このルールをスキップします。 ===`, (value) => `=== [gate] Invalid per_file_dir value: ${value} (use true / "file" / "pattern_root"). Skipping this rule. ===`);
var GATE_SKIP_BAD_PER_FILE_DIR = msg(() => "[skip: per_file_dir不正]", () => "[skip: invalid per_file_dir]");
var GATE_ROOT_NO_CWD = msg((label, cwd) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。このルートをスキップします。 ===`, (label, cwd) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Skipping this root. ===`);
var GATE_RULE_NO_CWD = msg((label, cwd) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。このルールをスキップします。 ===`, (label, cwd) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Skipping this rule. ===`);
var GATE_CHECK_NO_CWD = msg((name, cwd) => `=== [gate] (check:${name}) cwd が存在しません: ${cwd}。このチェックをスキップします。 ===`, (name, cwd) => `=== [gate] (check:${name}) cwd does not exist: ${cwd}. Skipping this check. ===`);
var GATE_SKIP_NO_CWD = msg(() => "[skip: cwd無し]", () => "[skip: no cwd]");
var GATE_NOTE_NO_CWD = msg(() => "(cwd が存在しません)", () => "(cwd does not exist)");
var GATE_WORKTREE_NOT_FOUND = msg((root) => `=== [gate] worktree が見つかりません: ${root}。対象から外します。 ===`, (root) => `=== [gate] worktree not found: ${root}. Excluding it. ===`);
var GATE_RULES_FAILED = msg(() => "[gate] rules フェーズの検証に失敗しました（会話は止まりません）。上のエラーを見て修正してください。", () => "[gate] The rules phase failed (the conversation is not stopped). See the errors above and fix them.");
var GATE_RULES_PASSED = msg((body) => `[gate] rules フェーズ成功:
${body}`, (body) => `[gate] rules phase passed:
${body}`);
var GATE_CHECK_NOT_FOUND = msg((name) => `=== [gate] consistency_checks に "${name}" が見つかりません。スキップします。 ===`, (name) => `=== [gate] "${name}" was not found in consistency_checks. Skipping. ===`);
var GATE_CHECK_NOT_FOUND_SUMMARY = msg((name) => `(check:${name}) 見つかりません、スキップ`, (name) => `(check:${name}) not found, skipped`);
var GATE_SKIP_CHECK_UNDEFINED = msg((name) => `[gate] skip: check:${name} (consistency_checks に定義がありません)`, (name) => `[gate] skip: check:${name} (not defined in consistency_checks)`);
var GATE_NOTHING_TO_RUN = msg(() => "（対象なし）", () => "(nothing to run)");
var GATE_ALL_PASSED = msg((labels) => `[gate] 検証がすべて通りました: ${labels}。この結果をユーザーに報告して終了してください。`, (labels) => `[gate] All checks passed: ${labels}. Report this result to the user and finish.`);
var GATE_DEFERRED_TITLE = msg(() => "後回しにした検証コマンド", () => "deferred verification commands");
var GATE_CHECKS_PASSED = msg((title, body) => `[gate] ${title} 成功:
${body}`, (title, body) => `[gate] ${title} passed:
${body}`);
var GATE_CHECKS_GAVE_UP_STDERR = msg((max) => `consistency checks が ${max} 回連続失敗。ループを打ち切ります。手動確認を。`, (max) => `consistency checks failed ${max} times in a row. Giving up the loop; please check manually.`);
var GATE_CHECKS_GAVE_UP = msg((max) => `[gate] consistency checks が${max}回連続で失敗したため打ち切りました。` + "対象ファイルは未検証のまま CHANGED へ戻しました。" + "手動で確認してください。今すぐ解除したい場合は新しいセッションを開始するか " + "/clear を実行してください（SessionStart の reset-gate が状態ファイルを削除します）。", (max) => `[gate] Gave up because consistency checks failed ${max} times in a row. ` + "The target files were returned to CHANGED unverified. " + "Please check them manually. To clear this now, start a new session or " + "run /clear (reset-gate on SessionStart removes the state files).");
var GATE_CHECKS_FAILED = msg((attempt, max) => `consistency checks 失敗（試行 ${attempt}/${max}）。上のエラーを見て修正を継続してください。`, (attempt, max) => `consistency checks failed (attempt ${attempt}/${max}). See the errors above and keep fixing.`);
var GATE_YML_TYPO = msg(() => "[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。拡張子が yaml ではなく yml になっていないか確認してください。", () => "[gate] .claude/gate.yaml was not found but .claude/gate.yml exists. Check whether the extension is yml instead of yaml.");
var GATE_POLICY_UNEVALUATED = msg((label, reason, cmd) => `=== [gate] (${label}) ポリシーを評価できないため今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）［${reason}］ $ ${cmd} ===`, (label, reason, cmd) => `=== [gate] (${label}) Skipped this time because the policy could not be evaluated (intentional throttling; no need to investigate. Queued, so it runs automatically later) [${reason}] $ ${cmd} ===`);
var GATE_POLICY_SKIPPED = msg((label, cmd) => `=== [gate] (${label}) ポリシーにより今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます） $ ${cmd} ===`, (label, cmd) => `=== [gate] (${label}) Skipped this time by policy (intentional throttling; no need to investigate. Queued, so it runs automatically later) $ ${cmd} ===`);
var GATE_NOTE_POLICY_SKIPPED = msg(() => "(ポリシー判定で見送り。控えに積んだので後で自動実行)", () => "(deferred by the policy verdict; queued to run automatically later)");
var GATE_NOTE_POLICY_UNEVALUATED = msg((reason) => `(ポリシーを評価できず見送り。控えに積んだので後で自動実行: ${reason})`, (reason) => `(deferred because the policy could not be evaluated; queued to run automatically later: ${reason})`);
var GATE_INTERNAL_ERROR = msg(() => "[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。", () => "[gate] An internal error occurred, so the checks were skipped (work continues). See stderr for details.");

// src/pyutil.ts
function truthy(v) {
  if (Array.isArray(v))
    return v.length > 0;
  if (v !== null && typeof v === "object")
    return Object.keys(v).length > 0;
  return Boolean(v);
}
function pyRepr(v) {
  if (v === null || v === undefined)
    return "None";
  if (v === true)
    return "True";
  if (v === false)
    return "False";
  if (typeof v === "number")
    return String(v);
  if (typeof v === "string") {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(v))
    return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  }
  return String(v);
}
function toCount(v) {
  if (!truthy(v))
    return 0;
  if (typeof v === "number")
    return Math.trunc(v);
  if (v === true)
    return 1;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v))
    return Number.parseInt(v, 10);
  return 0;
}
function pyRegExp(source, flags = "") {
  let src = source;
  let fl = flags;
  const m = /^\(\?([aiLmsux]+)\)/.exec(src);
  if (m) {
    src = src.slice(m[0].length);
    for (const c of m[1] ?? "")
      if ("ims".includes(c) && !fl.includes(c))
        fl += c;
  }
  src = src.replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>");
  return new RegExp(src, fl);
}
function jqStr(v) {
  if (v === null || v === undefined || v === false)
    return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}
var isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// src/agent-launch-guard.ts
var ASK_AGENT_TYPES = ["code-implementer"];
var ALLOW_RECIPIENTS = ["git-operator"];
var ask = (reason) => ok(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: reason
  }
})}
`);
function agentLaunchGuard(payload, lang) {
  const t = tr(lang);
  const tool = jqStr(payload.tool_name);
  const input = isDict(payload.tool_input) ? payload.tool_input : {};
  if (tool === "Agent") {
    const agentType = jqStr(input.subagent_type);
    if (agentType === "")
      return ok();
    if (ASK_AGENT_TYPES.includes(agentType)) {
      return ask(`${t(LAUNCH_PROMPT_TO, agentType)}

${jqStr(input.prompt)}

${t(LAUNCH_CHECKLIST)}`);
    }
  } else if (tool === "SendMessage") {
    const recipient = jqStr(input.to);
    if (!ALLOW_RECIPIENTS.includes(recipient)) {
      return ask(`${t(LAUNCH_MESSAGE_TO, recipient || t(LAUNCH_UNKNOWN_RECIPIENT))}

${jqStr(input.message)}

${t(LAUNCH_CHECKLIST)}`);
    }
  }
  return ok();
}

// src/path.ts
var isAbsolute = (p) => p.startsWith("/");
function join(...parts) {
  let out = "";
  for (const part of parts) {
    if (part.startsWith("/"))
      out = part;
    else if (out === "" || out.endsWith("/"))
      out += part;
    else
      out += `/${part}`;
  }
  return out;
}
function normpath(p) {
  if (p === "")
    return ".";
  const abs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".")
      continue;
    if (seg === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "..")
        out.pop();
      else if (!abs)
        out.push("..");
    } else {
      out.push(seg);
    }
  }
  const joined = out.join("/");
  if (abs)
    return `/${joined}`;
  return joined === "" ? "." : joined;
}
function dirname(p) {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  if (head !== "" && head !== "/".repeat(head.length))
    return head.replace(/\/+$/, "");
  return head;
}
function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}
function splitext(p) {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || /^\.+$/.test(base.slice(0, dot)))
    return [p, ""];
  const cut = p.length - base.length + dot;
  return [p.slice(0, cut), p.slice(cut)];
}
function relpath(path, start) {
  const a = normpath(path).split("/").filter(Boolean);
  const b = normpath(start).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i])
    i++;
  const rel = [...b.slice(i).map(() => ".."), ...a.slice(i)];
  return rel.length === 0 ? "." : rel.join("/");
}
function expandUser(p, home) {
  if (!home)
    return p;
  if (p === "~")
    return home;
  if (p.startsWith("~/"))
    return home.replace(/\/+$/, "") + p.slice(1);
  return p;
}

// src/glob.ts
function splitTopCommas(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") {
      depth++;
      cur += c;
    } else if (c === "}") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}
function expandBraces(s) {
  let depth = 0;
  let start = -1;
  for (let i = 0;i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const pre = s.slice(0, start);
        const inner = s.slice(start + 1, i);
        const post = s.slice(i + 1);
        const out = [];
        for (const part of splitTopCommas(inner))
          out.push(...expandBraces(pre + part + post));
        return out;
      }
    }
  }
  return [s];
}
var escapeRegex = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function globToRegex(pat) {
  const n = pat.length;
  let i = 0;
  let out = "^";
  while (i < n) {
    const c = pat.charAt(i);
    if (c === "*") {
      let j = i;
      while (j < n && pat.charAt(j) === "*")
        j++;
      if (j - i >= 2) {
        if (j < n && pat.charAt(j) === "/") {
          out += "(?:.*/)?";
          i = j + 1;
        } else {
          out += ".*";
          i = j;
        }
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (j < n && "!^".includes(pat.charAt(j)))
        j++;
      if (j < n && pat.charAt(j) === "]")
        j++;
      while (j < n && pat.charAt(j) !== "]")
        j++;
      let cls = pat.slice(i, j + 1);
      if (cls.startsWith("[!"))
        cls = `[^${cls.slice(2)}`;
      out += cls;
      i = j + 1;
    } else {
      out += escapeRegex(c);
      i++;
    }
  }
  return `${out}$`;
}
function matchPatterns(pats) {
  const pairs = [];
  for (const pat of pats) {
    for (const ex of expandBraces(pat))
      pairs.push([ex, new RegExp(globToRegex(ex))]);
  }
  return pairs;
}
var compileGlobs = (patterns) => matchPatterns(patterns).map(([, rx]) => rx);
function asList(v) {
  if (typeof v === "string")
    return [v];
  if (Array.isArray(v))
    return v;
  return [];
}
var hasMagic = (seg) => /[*?[]/.test(seg);
async function globExists(io, pattern) {
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter((s) => s !== "");
  return walk(io, abs ? "/" : "", segs, 0);
}
async function walk(io, dir, segs, i) {
  if (i >= segs.length)
    return dir === "" ? true : io.exists(dir);
  const seg = segs.at(i) ?? "";
  const here = dir === "" ? "." : dir;
  if (seg === "**") {
    if (i === segs.length - 1)
      return (await io.stat(here))?.kind === "dir";
    if (await walk(io, dir, segs, i + 1))
      return true;
    for (const e of await io.list(here)) {
      if (e.name.startsWith("."))
        continue;
      const sub = join(dir, e.name);
      if ((await io.stat(sub))?.kind === "dir" && await walk(io, sub, segs, i))
        return true;
    }
    return false;
  }
  if (!hasMagic(seg))
    return walk(io, join(dir, seg), segs, i + 1);
  const rx = new RegExp(globToRegex(seg));
  for (const e of await io.list(here)) {
    if (e.name.startsWith(".") && !seg.startsWith("."))
      continue;
    if (!rx.test(e.name))
      continue;
    if (await walk(io, join(dir, e.name), segs, i + 1))
      return true;
  }
  return false;
}

// node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = Symbol.for("yaml.alias");
var DOC = Symbol.for("yaml.document");
var MAP = Symbol.for("yaml.map");
var PAIR = Symbol.for("yaml.pair");
var SCALAR = Symbol.for("yaml.scalar");
var SEQ = Symbol.for("yaml.seq");
var NODE_TYPE = Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// node_modules/yaml/browser/dist/visit.js
var BREAK = Symbol("break visit");
var SKIP = Symbol("skip children");
var REMOVE = Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0;i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0;i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

class Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, Directives.defaultTags, tags);
  }
  clone() {
    const copy = new Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  atDocument() {
    const res = new Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, Directives.defaultTags);
        break;
    }
    return res;
  }
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join(`
`);
  }
}
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = new Set;
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1;; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = new Map;
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length;i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === undefined)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === undefined)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === undefined)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === undefined)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: undefined };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res) => {
      data.res = res;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// node_modules/yaml/browser/dist/nodes/Node.js
class NodeBase {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: new Map,
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res } of ctx.anchors.values())
        onAnchor(res, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
}

// node_modules/yaml/browser/dist/nodes/Alias.js
class Alias extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = undefined;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    if (found && ctx) {
      const { anchors, doc, maxAliasCount } = ctx;
      let data = anchors.get(found);
      if (!data) {
        toJS(found, null, ctx);
        data = anchors.get(found);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, found, anchors);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const source = this.resolve(ctx.doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    return ctx.anchors.get(source).res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
}
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

class Scalar extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
}
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map.items.push(value);
    return map;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
  let ref = undefined;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node = new Scalar(value);
      if (ref)
        ref.node = node;
      return node;
    }
    tagObj = value instanceof Map ? schema[MAP] : (Symbol.iterator in Object(value)) ? schema[SEQ] : schema[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema, path, value) {
  let v = value;
  for (let i = path.length - 1;i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = new Map([[k, v]]);
    }
  }
  return createNode(v, undefined, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema,
    sourceObjects: new Map
  });
}
var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

class Collection extends NodeBase {
  constructor(type, schema) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  clone(schema) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema)
      copy.schema = schema;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === undefined && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === undefined && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;

// node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = undefined;
  let prev = undefined;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch;ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === `
`) {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = undefined;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
        const next = text[i + 1];
        if (next && next !== " " && next !== `
` && next !== "\t")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = undefined;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "\t") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = undefined;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i = 0;i < folds.length; ++i) {
    const fold = folds[i];
    const end = folds[i + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "\t") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== `
`);
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

// node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock) => ({
  indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0;i < strLen; ++i) {
    if (str[i] === `
`) {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i];ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + `

`;
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += `
`;
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? `|
` : `>
`;
  let chomp;
  let endStart;
  for (endStart = value.length;endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== `
` && ch !== "\t" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf(`
`);
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === `
`)
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0;startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === `
`)
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes(`
`)) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: new Set,
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item) {
  if (item.tag) {
    const match = tags.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = undefined;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = undefined;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}

// node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? `
` : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === `
` && valueComment)
        ws = `

`;
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf(`
`);
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === `
`) {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}

// node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map, value) {
  const source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map, it);
  else
    mergeValue(ctx, map, source);
}
function mergeValue(ctx, map, value) {
  const source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value] of srcMap) {
    if (map instanceof Map) {
      if (!map.has(key))
        map.set(key, value);
    } else if (map instanceof Set) {
      map.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
      Object.defineProperty(map, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map instanceof Map) {
      map.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map instanceof Set) {
      map.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map)
        Object.defineProperty(map, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map[stringKey] = jsValue;
    }
  }
  return map;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = new Set;
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, undefined, ctx);
  const v = createNode(value, undefined, ctx);
  return new Pair(k, v);
}

class Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema);
    if (isNode(value))
      value = value.clone(schema);
    return new Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? new Map : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0;i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str = stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    if (chompKeep && comment)
      chompKeep = false;
    lines.push(blockItemPrefix + str);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1;i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : `
`;
    }
  }
  if (comment) {
    str += `
` + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0;i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify(item, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines.length > linesAtValue || str.includes(`
`));
    if (i < items.length - 1) {
      str += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str += ",";
      }
    }
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : `
`;
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}

// node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return;
}

class YAMLMap extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema) {
    super(MAP, schema);
    this.items = [];
  }
  static from(schema, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map = new this(schema);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== undefined || keepUndefined)
        map.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema.sortMapEntries === "function") {
      map.items.sort(schema.sortMapEntries);
    }
    return map;
  }
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? undefined;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  toJSON(_, ctx, Type) {
    const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
    if (ctx?.onCreate)
      ctx.onCreate(map);
    for (const item of this.items)
      addPairToJSMap(ctx, map, item);
    return map;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
}

// node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map, onError) {
    if (!isMap(map))
      onError("Expected a mapping for this tag");
    return map;
  },
  createNode: (schema, obj, ctx) => YAMLMap.from(schema, obj, ctx)
};

// node_modules/yaml/browser/dist/nodes/YAMLSeq.js
class YAMLSeq extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema) {
    super(SEQ, schema);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq);
    let i = 0;
    for (const item of this.items)
      seq.push(toJS(item, String(i++), ctx));
    return seq;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema, obj, ctx) {
    const { replacer } = ctx;
    const seq = new this(schema);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq.items.push(createNode(it, undefined, ctx));
      }
    }
    return seq;
  }
}
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq, onError) {
    if (!isSeq(seq))
      onError("Expected a sequence for this tag");
    return seq;
  },
  createNode: (schema, obj, ctx) => YAMLSeq.from(schema, obj, ctx)
};

// node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  default: false,
  tag: "tag:yaml.org,2002:binary",
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0;i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0;i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar.BLOCK_LITERAL ? `
` : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq, onError) {
  if (isSeq(seq)) {
    for (let i = 0;i < seq.items.length; ++i) {
      let item = seq.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq;
}
function createPairs(schema, iterable, ctx) {
  const { replacer } = ctx;
  const pairs = new YAMLSeq(schema);
  pairs.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs.items.push(createPair(key, value, ctx));
    }
  return pairs;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
class YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = YAMLOMap.tag;
  }
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map = new Map;
    if (ctx?.onCreate)
      ctx.onCreate(map);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map.set(key, value);
    }
    return map;
  }
  static from(schema, iterable, ctx) {
    const pairs = createPairs(schema, iterable, ctx);
    const omap = new this;
    omap.items = pairs.items;
    return omap;
  }
}
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq, onError) {
    const pairs = resolvePairs(seq, onError);
    const seenKeys = [];
    for (const { key } of pairs.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap, pairs);
  },
  createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n = BigInt(str);
    return sign === "-" ? BigInt(-1) * n : n;
  }
  const n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
class YAMLSet extends YAMLMap {
  constructor(schema) {
    super(schema);
    this.tag = YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema, iterable, ctx) {
    const { replacer } = ctx;
    const set = new this(schema);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set.items.push(createPair(value, null, ctx));
      }
    return set;
  }
}
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
  resolve(map, onError) {
    if (isMap(map)) {
      if (map.hasAllNullValues(true))
        return Object.assign(new YAMLSet, map);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map;
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign = str[0];
  const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
  resolve(str) {
    const match = str.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 60000 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// node_modules/yaml/browser/dist/schema/tags.js
var schemas = new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags.includes(tagObj))
      tags.push(tagObj);
    return tags;
  }, []);
}

// node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

class Schema {
  constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema === "string" && schema || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? undefined : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes(`
`)) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join(`
`) + `
`;
}

// node_modules/yaml/browser/dist/doc/Document.js
class Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
      replacer = undefined;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
  }
  clone() {
    const copy = Object.create(Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = undefined;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
      replacer = undefined;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(this, anchorPrefix || "a");
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
  }
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
  }
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== undefined;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: new Map,
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res } of ctx.anchors.values())
        onAnchor(res, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
}
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// node_modules/yaml/browser/dist/errors.js
class YAMLError extends Error {
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
}

class YAMLParseError extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
}

class YAMLWarning extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
}
var prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "…" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "…";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + `…
`;
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};

// node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes(`
`))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}

// node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}

// node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map.comment)
            map.comment += `
` + keyProps.comment;
          else
            map.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += `
` + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map.range = [bm.offset, offset, commentEnd ?? offset];
  return map;
}

// node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq.items.push(node);
  }
  seq.range = [bs.offset, offset, commentEnd ?? offset];
  return seq;
}

// node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
  const isMap = fc.start.source === "{";
  const fcName = isMap ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0;i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += `
` + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap && ctx.options.strict && containsNewline(key))
        onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop:
          for (const st of start) {
            switch (st.type) {
              case "comma":
              case "space":
                break;
              case "comment":
                prevItemComment = st.source.substring(1);
                break loop;
              default:
                break loop;
            }
          }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += `
` + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap && !sep && !props.found) {
      const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += `
` + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap) {
        const map = coll;
        if (mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map.items.push(pair);
      } else {
        const map = new YAMLMap(ctx.schema);
        map.flow = true;
        map.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += `
` + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}

// node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection(CN, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection(CN, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}

// node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1;i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
    let end = start + header.length;
    if (scalar.source)
      end += scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0;i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1;i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0;i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + `
`;
  for (let i = contentStart;i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = `
`;
    } else if (indent.length > trimIndent || content[0] === "\t") {
      if (sep === " ")
        sep = `
`;
      else if (!prevMoreIndented && sep === `
`)
        sep = `

`;
      value += sep + indent.slice(trimIndent) + content;
      sep = `
`;
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === `
`)
        value += `
`;
      else
        sep = `
`;
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart;i < lines.length; ++i)
        value += `
` + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== `
`)
        value += `
`;
      break;
    default:
      value += `
`;
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1;i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1;i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1;i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}

// node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    case "\t":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return unfoldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function unfoldLines(source) {
  const line = /(.*?)\r?\n/sy;
  let match = line.exec(source);
  if (!match)
    return source;
  let trimEnd, trimBoth;
  try {
    trimEnd = new RegExp("(?<![ \t])[ \t]+$");
    trimBoth = new RegExp("^[ \t]+|(?<![ \t])[ \t]+$", "g");
  } catch {
    trimEnd = /[ \t]+$/;
    trimBoth = /^[ \t]+|[ \t]+$/g;
  }
  let res = match[1].replace(trimEnd, "");
  let sep = " ";
  let pos = line.lastIndex;
  while (match = line.exec(source)) {
    const lm = match[1].replace(trimBoth, "");
    if (lm === "") {
      if (sep === `
`)
        res += sep;
      else
        sep = `
`;
    } else {
      res += sep + lm;
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1;i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === `
`)
      continue;
    if (ch === `
`) {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === `
`) {
        next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === `
`) {
        next = source[++i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "\t") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "\t")
        next = source[++i + 1];
      if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== `
`)
      break;
    if (ch === `
`)
      fold += `
`;
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
var escapeCodes = {
  "0": "\x00",
  a: "\x07",
  b: "\b",
  e: "\x1B",
  f: "\f",
  n: `
`,
  r: "\r",
  t: "\t",
  v: "\v",
  N: "",
  _: " ",
  L: "\u2028",
  P: "\u2029",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "\t": "\t"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code);
  } catch {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
}

// node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema[SCALAR];
  const matchWithTest = [];
  for (const tag of schema.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema.knownTags[tagName];
  if (kt && !kt.collection) {
    schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema[SCALAR];
}
function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
  const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[SCALAR];
  if (schema.compat) {
    const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}

// node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1;i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}

// node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      isSrcToken = false;
    }
  }
  node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}

// node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(undefined, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}

// node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0;i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}

class Composer {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code, message));
      else
        this.errors.push(new YAMLParseError(pos, code, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0;i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0;i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(undefined, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
}
// node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = Symbol("break visit");
var SKIP2 = Symbol("skip children");
var REMOVE2 = Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item = cst;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return;
  }
  return item;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0;i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}

// node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "\x02";
var FLOW_END = "\x18";
var SCALAR2 = "\x1F";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case `
`:
    case `\r
`:
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "\t":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case undefined:
    case " ":
    case `
`:
    case "\r":
    case "\t":
      return true;
    default:
      return false;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(` ,[]{}
\r	`);
var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

class Lexer {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "\t")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === `
`)
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === `
`;
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === `
` || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf(`
`, this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "\t") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "\t")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      case undefined:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case undefined:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf(`
`, this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf(`
`, cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop:
      for (let i = this.pos;ch = this.buffer[i]; ++i) {
        switch (ch) {
          case " ":
            indent += 1;
            break;
          case `
`:
            nl = i;
            indent = 0;
            break;
          case "\r": {
            const next = this.buffer[i + 1];
            if (!next && !this.atEnd)
              return this.setNext("block-scalar");
            if (next === `
`)
              break;
          }
          default:
            break loop;
        }
      }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf(`
`, cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "\t") {
      while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i = nl - 1;
        let ch = this.buffer[i];
        if (ch === "\r")
          ch = this.buffer[--i];
        const lastChar = i;
        while (ch === " ")
          ch = this.buffer[--i];
        if (ch === `
` && i >= this.pos && i + 1 + indent > lastChar)
          nl = i;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === `
`) {
            i += 1;
            ch = `
`;
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === `
`) {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    let n = 0;
    loop:
      while (true) {
        switch (this.charAt(0)) {
          case "!":
            n += yield* this.pushTag();
            n += yield* this.pushSpaces(true);
            continue loop;
          case "&":
            n += yield* this.pushUntil(isNotAnchorChar);
            n += yield* this.pushSpaces(true);
            continue loop;
          case "-":
          case "?":
          case ":": {
            const inFlow = this.flowLevel > 0;
            const ch1 = this.charAt(1);
            if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
              if (!inFlow)
                this.indentNext = this.indentValue + 1;
              else if (this.flowKey)
                this.flowKey = false;
              n += yield* this.pushCount(1);
              n += yield* this.pushSpaces(true);
              continue loop;
            }
          }
        }
        break loop;
      }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === `
`)
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === `
`)
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "\t");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
}
// node_modules/yaml/browser/dist/parse/line-counter.js
class LineCounter {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
}
// node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0;i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0;i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop:
    while (--i >= 0) {
      switch (prev[i].type) {
        case "doc-start":
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
        case "newline":
          break loop;
      }
    }
  while (prev[++i]?.type === "space") {}
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0;i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            arrayPushArray(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          arrayPushArray(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}

class Parser {
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer;
    this.onNewLine = onNewLine;
  }
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf(`
`) + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf(`
`, nl) + 1;
          }
        }
        yield* this.pop();
        break;
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map) {
    const it = map.items[map.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : undefined;
          const last = Array.isArray(end) ? end[end.length - 1] : undefined;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map.indent)) {
            const prev = map.items[map.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              map.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0;i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq) {
    const it = seq.items[seq.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : undefined;
          const last = Array.isArray(end) ? end[end.length - 1] : undefined;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq.indent)) {
            const prev = seq.items[seq.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              seq.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq.indent) {
      const bv = this.startBlockValue(seq);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf(`
`) + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf(`
`, nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
}
// node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter || null;
  return { lineCounter, prettyErrors };
}
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}
function parse(src, reviver, options) {
  let _reviver = undefined;
  if (typeof reviver === "function") {
    _reviver = reviver;
  } else if (options === undefined && reviver && typeof reviver === "object") {
    options = reviver;
  }
  const doc = parseDocument(src, options);
  if (!doc)
    return null;
  doc.warnings.forEach((warning) => warn(doc.options.logLevel, warning));
  if (doc.errors.length > 0) {
    if (doc.options.logLevel !== "silent")
      throw doc.errors[0];
    else
      doc.errors = [];
  }
  return doc.toJS(Object.assign({ reviver: _reviver }, options));
}
// src/load-yaml.ts
var PY_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
var PY_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/;
var pyBool = (original) => ({
  ...original,
  test: /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON|no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  resolve: (str) => PY_TRUE.test(str) ? true : PY_FALSE.test(str) ? false : str
});
var parseYaml = (text) => parse(text, {
  schema: "yaml-1.1",
  uniqueKeys: false,
  logLevel: "error",
  customTags: (tags) => tags.map((t) => typeof t === "object" && ("tag" in t) && t.tag === "tag:yaml.org,2002:bool" ? pyBool(t) : t)
});

// src/roots.ts
function relativize(p, projectDir) {
  let rp = p;
  if (isAbsolute(p))
    rp = relpath(p, projectDir);
  if (rp.startsWith("./"))
    rp = rp.slice(2);
  return rp;
}
function splitRoot(projectDir, path) {
  const worktreesDir = normpath(join(projectDir, ".claude", "worktrees"));
  const abs = normpath(isAbsolute(path) ? path : join(projectDir, path));
  const relToWt = relpath(abs, worktreesDir);
  if (relToWt !== "." && relToWt !== ".." && !relToWt.startsWith("../")) {
    const slash = relToWt.indexOf("/");
    const name = slash < 0 ? relToWt : relToWt.slice(0, slash);
    const rest = slash < 0 ? "" : relToWt.slice(slash + 1);
    return [normpath(join(worktreesDir, name)), rest];
  }
  return [projectDir, relativize(path, projectDir)];
}

// src/feedback-rules.ts
function feedbackDir(io) {
  const override = io.env.CLAUDE_FEEDBACK_DIR;
  if (override)
    return override;
  return join(io.env.HOME || "~", ".claude", "feedback");
}
function projectFeedbackDir(io, projectDir) {
  return join(projectDir || io.projectDir || io.cwd, ".claude", "feedback");
}
var violationsLogPath = (io) => join(feedbackDir(io), ".violations.jsonl");
var FRONTMATTER_RE = /^---\s*\n([\s\S]*?\n)---\s*\n?/;
var BODY_STOP_RE = /\*\*(Why|言い訳|Excuse|How to apply)[:：]?\*\*/;
var loadYamlText = (text) => parseYaml(text);
var DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
var DAY_MS = 86400000;
function parseExpires(v) {
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t))
      return;
    return t % DAY_MS === 0 ? t + DAY_MS - 1 : t;
  }
  if (typeof v !== "string")
    return;
  const text = v.trim();
  const t = Date.parse(text);
  if (Number.isNaN(t))
    return;
  return DATE_ONLY_RE.test(text) ? t + DAY_MS - 1 : t;
}
var stringList = (v) => asList(v).filter((x) => typeof x === "string");
async function loadRule(io, path) {
  const content = await io.readFile(path);
  if (content === undefined)
    return null;
  const m = FRONTMATTER_RE.exec(content);
  if (!m)
    return null;
  const data = loadYamlText(m[1] ?? "");
  if (!isDict(data) || !truthy(data.name))
    return null;
  return {
    name: String(data.name),
    description: truthy(data.description) ? String(data.description) : "",
    count: toCount(data.count),
    enforce: truthy(data.enforce) ? data.enforce : [],
    path,
    expires: parseExpires(data.expires),
    projects: stringList(data.projects),
    whenExists: stringList(data.when_exists)
  };
}
function expandTilde(io, pattern) {
  const home = io.env.HOME;
  if (!home || pattern !== "~" && !pattern.startsWith("~/"))
    return pattern;
  return join(home, pattern.slice(2));
}
async function isRuleActive(io, rule, projectDir) {
  if (rule.expires !== undefined && await io.now() > rule.expires)
    return false;
  const dir = projectDir || io.projectDir || io.cwd;
  if (rule.projects.length > 0) {
    const rxs = compileGlobs(rule.projects.map((p) => expandTilde(io, p)));
    if (!rxs.some((rx) => rx.test(dir)))
      return false;
  }
  if (rule.whenExists.length > 0) {
    let found = false;
    for (const pattern of rule.whenExists) {
      for (const expanded of expandBraces(pattern)) {
        if (await globExists(io, join(dir, expanded))) {
          found = true;
          break;
        }
      }
      if (found)
        break;
    }
    if (!found)
      return false;
  }
  return true;
}
async function loadBodyIntro(io, path) {
  const content = await io.readFile(path);
  if (content === undefined)
    return "";
  const m = FRONTMATTER_RE.exec(content);
  const body = m ? content.slice(m[0].length) : content;
  const stop = BODY_STOP_RE.exec(body);
  const lead = (stop ? body.slice(0, stop.index) : body).trim();
  if (!lead)
    return "";
  return (lead.split(`

`)[0] ?? "").trim();
}
async function listRulesIn(io, d) {
  const rules = [];
  const names = (await io.list(d)).map((e) => e.name).sort();
  for (const name of names) {
    if (!name.endsWith(".md"))
      continue;
    const rule = await loadRule(io, join(d, name));
    if (rule)
      rules.push(rule);
  }
  return rules;
}
async function listRules(io, feedbackDirPath) {
  if (feedbackDirPath)
    return listRulesIn(io, feedbackDirPath);
  const globalDir = feedbackDir(io);
  const projectDir = projectFeedbackDir(io);
  const globalRules = await listRulesIn(io, globalDir);
  let merged = globalRules;
  if (projectDir !== globalDir) {
    const projectRules = await listRulesIn(io, projectDir);
    const overridden = new Set(projectRules.map((r) => r.name));
    merged = [...globalRules.filter((r) => !overridden.has(r.name)), ...projectRules];
  }
  const active = [];
  for (const r of merged)
    if (await isRuleActive(io, r))
      active.push(r);
  return active;
}
function resolveSeverity(count, explicit, event) {
  if (truthy(explicit))
    return String(explicit);
  const n = toCount(count);
  if (n >= 5)
    return "deny";
  if (n >= 3)
    return event === "stop_check" || event === "post_edit" ? "block" : "ask";
  return "warn";
}
var logQueue = Promise.resolve();
function logViolation(io, rule, count, severity, event, detail) {
  const task = logQueue.then(async () => {
    try {
      const ts = new Date(await io.now()).toISOString().replace("Z", "+00:00");
      const entry = { ts, rule, count, severity, event, detail };
      const path = violationsLogPath(io);
      const existing = await io.readFile(path) ?? "";
      await io.writeFile(path, `${existing}${JSON.stringify(entry)}
`);
    } catch {}
  });
  logQueue = task;
  return task;
}
function looksLikeTestFile(name) {
  if (/_test\.go$/.test(name))
    return true;
  if (/\.(test|spec)\.tsx?$/.test(name))
    return true;
  if (/_(spec|test)\.rb$/.test(name))
    return true;
  if (/^test_.*\.py$/.test(name) || /_test\.py$/.test(name))
    return true;
  return false;
}
function stemVariants(stem) {
  const variants = [stem];
  if (stem.includes("-")) {
    const alt = stem.replaceAll("-", "_");
    if (!variants.includes(alt))
      variants.push(alt);
  }
  if (stem.includes("_")) {
    const alt = stem.replaceAll("_", "-");
    if (!variants.includes(alt))
      variants.push(alt);
  }
  return variants;
}
function stemBrace(stem) {
  const variants = stemVariants(stem);
  return variants.length === 1 ? variants[0] : `{${variants.join(",")}}`;
}
function expandStem(pattern, path) {
  const stem = splitext(basename(path))[0];
  return expandBraces(pattern.replaceAll("{stem}", stemBrace(stem)));
}
function expandTestPattern(pattern, relPath) {
  const stem = splitext(basename(relPath))[0];
  return pattern.replaceAll("{stem}", stemBrace(stem)).replaceAll("{dir}", dirname(relPath) || ".");
}
function extractPreEditContent(toolName, toolInput) {
  const s = (v) => truthy(v) ? String(v) : "";
  if (toolName === "Write")
    return s(toolInput.content);
  if (toolName === "Edit")
    return s(toolInput.new_string);
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    return edits.filter(isDict).map((e) => s(e.new_string)).join(`
`);
  }
  return "";
}
var SHELL = ["sh", "-c"];
async function evalPreBash(io, rules, command, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  const violations = [];
  if (!command)
    return violations;
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== "pre_bash")
        continue;
      const when = entry.when;
      if (!truthy(when) || !pyRegExp(String(when)).test(command))
        continue;
      const unless = entry.unless;
      if (truthy(unless) && pyRegExp(String(unless)).test(command))
        continue;
      const checkCmd = entry.check;
      if (truthy(checkCmd)) {
        io.progress?.(tr(io.lang)(GUARD_EVALUATING, rule.name));
        const r = await io.run([...SHELL, String(checkCmd)], { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir }, timeoutMs: 1e4 });
        if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
          continue;
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, "pre_bash"),
        event: "pre_bash",
        message: truthy(entry.message) ? String(entry.message) : "",
        detail: `command matched: ${String(when)}`
      });
    }
  }
  return violations;
}
async function evalPreEdit(io, rules, filePath, content, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  const [root, rel] = splitRoot(dir, filePath);
  const name = basename(filePath);
  const text = content || "";
  const violations = [];
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== "pre_edit")
        continue;
      const patterns = asList(entry.path);
      if (patterns.length === 0)
        continue;
      if (!compileGlobs(patterns).some((rx) => rx.test(rel)))
        continue;
      const exclPatterns = asList(entry.exclude_path);
      if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel)))
        continue;
      const absentSibling = entry.absent_sibling;
      const absentGlobs = asList(entry.absent_glob);
      let detail;
      if (truthy(absentSibling) || absentGlobs.length > 0) {
        if (looksLikeTestFile(name))
          continue;
        const candidates = [];
        let found = false;
        if (truthy(absentSibling)) {
          const sibNames = expandStem(String(absentSibling), filePath);
          candidates.push(...sibNames);
          for (const sib of sibNames) {
            if (await io.exists(join(dirname(filePath), sib))) {
              found = true;
              break;
            }
          }
        }
        for (const pat of absentGlobs) {
          if (found)
            break;
          for (const expanded of expandBraces(expandTestPattern(pat, rel))) {
            candidates.push(expanded);
            if (await globExists(io, join(root, expanded))) {
              found = true;
              break;
            }
          }
        }
        if (found)
          continue;
        detail = `missing test file: ${candidates.join(", ")}`;
      } else {
        const when = entry.when;
        if (!truthy(when) || !pyRegExp(String(when), "m").test(text))
          continue;
        const unless = entry.unless;
        if (truthy(unless) && pyRegExp(String(unless), "m").test(text))
          continue;
        detail = `content matched: ${String(when)}`;
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, "pre_edit"),
        event: "pre_edit",
        message: truthy(entry.message) ? String(entry.message) : "",
        detail
      });
    }
  }
  return violations;
}
async function evalPostEdit(io, rules, filePath, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  const [root, rel] = splitRoot(dir, filePath);
  const absPath = isAbsolute(filePath) ? filePath : join(dir, filePath);
  const violations = [];
  let text;
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== "post_edit")
        continue;
      const patterns = asList(entry.path);
      if (patterns.length === 0)
        continue;
      if (!compileGlobs(patterns).some((rx) => rx.test(rel)))
        continue;
      const exclPatterns = asList(entry.exclude_path);
      if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel)))
        continue;
      const when = entry.when;
      const checkCmd = entry.check;
      if (!truthy(when) && !truthy(checkCmd))
        continue;
      if (text === undefined) {
        text = await io.readFile(absPath);
        if (text === undefined)
          return violations;
      }
      const details = [];
      if (truthy(when)) {
        if (!pyRegExp(String(when), "m").test(text))
          continue;
        const unless = entry.unless;
        if (truthy(unless) && pyRegExp(String(unless), "m").test(text))
          continue;
        details.push(`content matched: ${String(when)}`);
      }
      if (truthy(checkCmd)) {
        io.progress?.(tr(io.lang)(POST_EDIT_CHECKING, rule.name, absPath));
        const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: dir, FILE: absPath }, timeoutMs: 15000 });
        if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
          continue;
        details.push(`check failed: ${String(checkCmd)}`);
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, "post_edit"),
        event: "post_edit",
        message: truthy(entry.message) ? String(entry.message) : "",
        detail: details.join(", ")
      });
    }
  }
  return violations;
}
async function readLines(io, path) {
  const text = await io.readFile(path);
  if (text === undefined)
    return;
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
}
async function gitFallbackFiles(io, cwd) {
  const files = new Set;
  for (const args of [
    ["git", "diff", "--name-only", "HEAD"],
    ["git", "ls-files", "--others", "--exclude-standard"]
  ]) {
    const r = await io.run(args, { cwd, timeoutMs: 1e4 });
    if (r.exitCode === 0 && !r.timedOut && r.error === undefined) {
      for (const l of r.stdout.split(/\r?\n/))
        if (l.trim() !== "")
          files.add(l.trim());
    }
  }
  return [...files].sort();
}
async function getChangedFiles(io, projectDir, sessionId, agentId) {
  const claudeDir = join(projectDir, ".claude");
  const stateDir = join(claudeDir, ".gate-status");
  if (agentId) {
    const lines = await readLines(io, join(stateDir, `changed_files.${sessionId}--${agentId}.txt`));
    if (lines !== undefined)
      return lines;
    const worktree = join(claudeDir, "worktrees", `agent-${agentId}`);
    if ((await io.stat(worktree))?.kind === "dir") {
      return (await gitFallbackFiles(io, worktree)).map((f) => join(worktree, f));
    }
    return gitFallbackFiles(io, projectDir);
  }
  const seen = new Set;
  const merged = [];
  let foundAny = false;
  const add = (lines) => {
    for (const l of lines) {
      if (!seen.has(l)) {
        seen.add(l);
        merged.push(l);
      }
    }
  };
  const plain = await readLines(io, join(stateDir, `changed_files.${sessionId}.txt`));
  if (plain !== undefined) {
    foundAny = true;
    add(plain);
  }
  const prefix = `changed_files.${sessionId}--`;
  const agentMemos = (await io.list(stateDir)).map((e) => e.name).filter((n) => n.startsWith(prefix) && n.endsWith(".txt") && n.length >= prefix.length + 4).sort();
  for (const name of agentMemos) {
    foundAny = true;
    add(await readLines(io, join(stateDir, name)) ?? []);
  }
  if (foundAny)
    return merged;
  return gitFallbackFiles(io, projectDir);
}
async function evalStopCheck(io, rules, projectDir, changedFiles) {
  const keyed = changedFiles.map((f) => splitRoot(projectDir, f));
  const violations = [];
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== "stop_check")
        continue;
      const patterns = asList(entry.changed);
      if (patterns.length === 0)
        continue;
      const rxs = compileGlobs(patterns);
      const matchedKeys = new Set;
      for (const [root, rel] of keyed)
        if (rxs.some((rx) => rx.test(rel)))
          matchedKeys.add(`${root}\x00${rel}`);
      const matched = [...matchedKeys].sort().map((k) => k.split("\x00"));
      if (matched.length === 0)
        continue;
      const checkCmd = entry.check;
      const requireSibling = entry.require_sibling;
      const badFiles = [];
      for (const [root, rel] of matched) {
        const absPath = join(root, rel);
        let bad = false;
        if (truthy(requireSibling)) {
          const sibNames = expandStem(String(requireSibling), absPath);
          let any = false;
          for (const sib of sibNames) {
            if (await io.exists(join(dirname(absPath), sib))) {
              any = true;
              break;
            }
          }
          if (!any)
            bad = true;
        }
        if (truthy(checkCmd)) {
          io.progress?.(tr(io.lang)(STOP_CHECK_CHECKING, rule.name, absPath));
          const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: projectDir, FILE: absPath }, timeoutMs: 15000 });
          if (r.exitCode !== 0 || r.timedOut || r.error !== undefined)
            bad = true;
        }
        if (bad)
          badFiles.push(root === projectDir ? rel : `${basename(root)}/${rel}`);
      }
      if (badFiles.length > 0) {
        violations.push({
          rule: rule.name,
          count: rule.count,
          severity: resolveSeverity(rule.count, entry.severity, "stop_check"),
          event: "stop_check",
          message: truthy(entry.message) ? String(entry.message) : "",
          detail: `changed files violating: ${badFiles.join(", ")}`
        });
      }
    }
  }
  return violations;
}

// src/feedback-stop-check.ts
var MAX_ATTEMPTS = 3;
var attemptsPath = (projectDir, sessionId, agentId) => join(projectDir, ".claude", ".gate-status", `feedback_gate_attempts.${agentId ? `${sessionId}--${agentId}` : sessionId}.txt`);
async function bumpAttempts(io, path) {
  let attempts = 0;
  const text = await io.readFile(path);
  if (text !== undefined && /^\s*[+-]?\d+\s*$/.test(text))
    attempts = Number.parseInt(text.trim(), 10);
  attempts += 1;
  try {
    await io.writeFile(path, String(attempts));
  } catch {}
  return attempts;
}
async function main(io, payload) {
  const projectDir = io.projectDir || io.cwd;
  const sessionId = truthy(payload.session_id) ? String(payload.session_id) : "unknown";
  const agentId = truthy(payload.agent_id) ? String(payload.agent_id) : null;
  const ap = attemptsPath(projectDir, sessionId, agentId);
  const files = await getChangedFiles(io, projectDir, sessionId, agentId);
  if (files.length === 0) {
    await io.removeFiles([ap]);
    return ok();
  }
  const rules = await listRules(io);
  const violations = await evalStopCheck(io, rules, projectDir, files);
  if (violations.length === 0) {
    await io.removeFiles([ap]);
    return ok();
  }
  for (const v of violations)
    await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail);
  const warnings = violations.filter((v) => v.severity === "warn");
  const blocking = violations.filter((v) => v.severity !== "warn");
  let stderr = warnings.map((v) => `[feedback-stop-check] warn: ${v.rule} (count: ${v.count}): ${v.message}
`).join("");
  if (blocking.length === 0) {
    await io.removeFiles([ap]);
    return ok("", stderr);
  }
  const attempts = await bumpAttempts(io, ap);
  if (attempts >= MAX_ATTEMPTS) {
    stderr += `${tr(io.lang)(STOP_CHECK_GAVE_UP, MAX_ATTEMPTS)}
`;
    await io.removeFiles([ap]);
    return ok("", stderr);
  }
  const lines = blocking.map((v) => `[feedback-stop-check] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`);
  lines.push(tr(io.lang)(STOP_CHECK_FIX_ABOVE, attempts, MAX_ATTEMPTS));
  stderr += lines.map((l) => `${l}
`).join("");
  const stdout = `${JSON.stringify({ decision: "block", reason: lines.join(`
`) })}
`;
  return { exitCode: 2, stdout, stderr };
}
async function feedbackStopCheck(io, payload) {
  try {
    return await main(io, payload);
  } catch (e) {
    return ok("", `[feedback-stop-check] internal error (ignored): ${e instanceof Error ? e.message : String(e)}
`);
  }
}

// src/shell.ts
var SAFE = /^[A-Za-z0-9@%+=:,./-]+$/;
function shellQuote(s) {
  if (s === "")
    return "''";
  if (SAFE.test(s))
    return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
function shellSplit(s) {
  const out = [];
  let cur = "";
  let inToken = false;
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0)
        throw new Error("No closing quotation");
      cur += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      inToken = true;
      for (;; ) {
        if (i >= s.length)
          throw new Error("No closing quotation");
        const d = s.charAt(i);
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && '"\\$`\n'.includes(s.charAt(i + 1)) && i + 1 < s.length) {
          cur += s.charAt(i + 1);
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 >= s.length)
        throw new Error("No escaped character");
      cur += s.charAt(i + 1);
      inToken = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (inToken)
        out.push(cur);
      cur = "";
      inToken = false;
      i++;
    } else {
      cur += c;
      inToken = true;
      i++;
    }
  }
  if (inToken)
    out.push(cur);
  return out;
}

// src/which.ts
async function which(io, name) {
  if (name.includes("/"))
    return await io.isExecutable(name) ? name : undefined;
  for (const dir of (io.env.PATH ?? "").split(":")) {
    if (dir === "")
      continue;
    const candidate = join(dir, name);
    if (await io.isExecutable(candidate))
      return candidate;
  }
  return;
}

// src/notification.ts
var LABELS = {
  notify: { label: NOTIFY_WAITING, fallback: NOTIFY_WAITING_FALLBACK },
  stop: { label: NOTIFY_DONE, fallback: NOTIFY_DONE_FALLBACK }
};
var FRONT_WINDOW_SCRIPT = 'tell application "System Events" to tell (first process whose frontmost is true) to get name of (first window whose value of attribute "AXMain" is true)';
async function notification(io, type, payload) {
  const kind = LABELS[type];
  if (!kind)
    return ok();
  const t = tr(io.lang);
  const cwd = jqStr(payload.cwd) || io.cwd;
  const message = jqStr(payload.message) || t(kind.fallback);
  const top = await io.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  const gitRoot = top.exitCode === 0 ? top.stdout.replace(/\n+$/, "") : "";
  const target = gitRoot || cwd;
  const project = basename(target);
  const front = await io.run(["osascript", "-e", FRONT_WINDOW_SCRIPT]);
  const frontName = front.exitCode === 0 ? front.stdout.replace(/\n+$/, "") : "";
  if (frontName.includes(project))
    return ok();
  let isVscode = true;
  let appBundle = "com.microsoft.VSCode";
  switch (io.env.TERM_PROGRAM ?? "") {
    case "vscode":
      appBundle = io.env.__CFBundleIdentifier || "com.microsoft.VSCode";
      break;
    case "iTerm.app":
      appBundle = "com.googlecode.iterm2";
      isVscode = false;
      break;
    case "WarpTerminal":
      appBundle = "dev.warp.Warp-Terminal";
      isVscode = false;
      break;
    case "Ghostty":
      appBundle = "com.mitchellh.ghostty";
      isVscode = false;
      break;
    case "Apple_Terminal":
      appBundle = "com.apple.Terminal";
      isVscode = false;
      break;
  }
  let click = `open -b ${shellQuote(appBundle)}`;
  if (isVscode) {
    let codeBin = await which(io, "code") ?? "";
    if (!(codeBin && await io.isExecutable(codeBin)))
      codeBin = "/usr/local/bin/code";
    if (await io.isExecutable(codeBin))
      click = `${shellQuote(codeBin)} -r ${shellQuote(target)}`;
  }
  if (!await which(io, "terminal-notifier"))
    return ok();
  await io.run([
    "terminal-notifier",
    "-title",
    "Claude Code",
    "-subtitle",
    `\uD83D\uDCC1 ${project} · ${t(kind.label)}`,
    "-message",
    message,
    "-group",
    `claude-code-${target}`,
    "-execute",
    click
  ]);
  return ok();
}

// src/running-registry.ts
var MAX_RUN_MS = 600000;
var STALE_MS = MAX_RUN_MS + 60000;
var gateStatusDir = (io) => join(io.projectDir || io.cwd, ".claude", ".gate-status");
var runningDir = (io) => join(gateStatusDir(io), "running");
var ownerFile = (io, owner) => join(runningDir(io), `${owner}.json`);
var publishRunning = (io, owner, entries) => io.writeFile(ownerFile(io, owner), JSON.stringify(entries));
var withdrawRunning = (io, owner) => io.removeFiles([ownerFile(io, owner)]);
function mergeRunning(texts, now) {
  const groups = [];
  for (const text of texts) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const entries = (Array.isArray(parsed) ? parsed : []).filter(isDict);
    if (entries.length === 0 || Math.max(...entries.map((e) => e.started)) < now - STALE_MS)
      continue;
    groups.push(entries);
  }
  groups.sort((a, b) => a[0].started - b[0].started);
  return groups.flat();
}
var ownedBySession = (name, sessionId) => name.startsWith(`${sessionId}.`) || name.startsWith(`${sessionId}--`);
async function listRunning(io, sessionId) {
  const now = await io.now();
  const texts = [];
  for (const f of await io.list(runningDir(io))) {
    if (f.kind !== "file" || !f.name.endsWith(".json") || !ownedBySession(f.name, sessionId))
      continue;
    const text = await io.readFile(join(runningDir(io), f.name));
    if (text !== undefined)
      texts.push(text);
  }
  return mergeRunning(texts, now);
}
var BAND_LINE_MAX = 80;
var INDENT = "  ";
var ELLIPSIS = " ...";
function foldCmd(cmd) {
  const lines = cmd.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return `${lines[0] ?? ""}${lines.length > 1 ? ELLIPSIS : ""}`;
}
function cutCmd(text, room) {
  if (text.length <= room)
    return text;
  const limit = Math.max(0, room - ELLIPSIS.length);
  let head = text.slice(0, limit);
  if (text[limit] !== " ") {
    const space = head.lastIndexOf(" ");
    if (space > 0)
      head = head.slice(0, space);
  }
  return `${head.trimEnd()}${ELLIPSIS}`;
}
var markOf = (e) => e.result === "ok" ? "✓" : "✗";
var doneText = (e, now) => `${e.name ?? foldCmd(e.cmd)} ${markOf(e)} (${(((e.ended ?? now) - e.started) / 1000).toFixed(1)}s)`;
function runningLine(e, now, lang) {
  if (e.result)
    return `${INDENT}${doneText(e, now)}`;
  const seconds = Math.max(0, Math.floor((now - e.started) / 1000));
  const head = e.name ? `${INDENT}${e.name} $ ` : INDENT;
  const tail = `${e.waiting ? ` ${tr(lang)(BAND_WAITING)}` : ""} (${seconds}s)`;
  return `${head}${cutCmd(foldCmd(e.cmd), BAND_LINE_MAX - head.length - tail.length)}${tail}`;
}
function runningLines(entries, now, lang) {
  return [tr(lang)(BAND_RUNNING), ...entries.map((e) => runningLine(e, now, lang))];
}
function runningBand(entries, now, lang) {
  if (!entries.some((e) => !e.result))
    return;
  return {
    type: "Box",
    props: { flexDirection: "column" },
    children: runningLines(entries, now, lang).map((line) => ({ type: "Text", children: [line] }))
  };
}
function finishedSummary(entries, lang) {
  if (entries.length === 0 || entries.some((e) => !e.result))
    return;
  const passed = entries.filter((e) => e.result === "ok").length;
  const failed = entries.length - passed;
  const counts = [passed > 0 ? `✓ ${passed}` : "", failed > 0 ? `✗ ${failed}` : ""].filter((s) => s !== "").join(" / ");
  const first = Math.min(...entries.map((e) => e.started));
  const last = Math.max(...entries.map((e) => e.ended ?? e.started));
  return tr(lang)(BAND_DONE, counts, ((last - first) / 1000).toFixed(1));
}
var summaryFile = (io, sessionId) => join(gateStatusDir(io), `summary.${sessionId}.txt`);
var saveSummary = (io, sessionId, text) => io.writeFile(summaryFile(io, sessionId), text);
var clearSummary = (io, sessionId) => io.removeFiles([summaryFile(io, sessionId)]);
async function loadSummary(io, sessionId) {
  const text = await io.readFile(summaryFile(io, sessionId));
  return text === undefined || text === "" ? undefined : text;
}

// src/shared-run.ts
var GRACE_MS = 5000;
var MAX_WAIT_MS = 600000;
var MAX_ROUNDS = 20;
var POLL_SECONDS = "0.05";
function hashKey(key) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0;i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
var normalizeFiles = (files) => [...new Set(files)].sort();
var shareId = (key, files) => `${hashKey(key)}.${hashKey(JSON.stringify(normalizeFiles(files)))}`;
async function runShared(io, key, files, timeoutMs, execute, hooks = {}) {
  const mine = normalizeFiles(files);
  const dir = join(gateStatusDir(io), "shared");
  const keyPrefix = `${hashKey(key)}.`;
  const ownLock = join(dir, `${shareId(key, mine)}.run`);
  const resultOf = (lock) => `${lock.slice(0, -".run".length)}.result.json`;
  const claim = async () => (await io.run(["sh", "-c", 'mkdir -p "$1" && mkdir "$2"', "sh", dir, ownLock])).exitCode === 0;
  const lead = async () => {
    const resultFile = resultOf(ownLock);
    await io.writeFile(join(ownLock, "info.json"), JSON.stringify({ started: await io.now(), timeoutMs, key, files: mine }));
    await io.removeFiles([resultFile]);
    try {
      const outcome = await execute();
      await io.writeFile(resultFile, JSON.stringify({ key, files: mine, ...outcome }));
      return outcome;
    } finally {
      await io.removeTree(ownLock);
    }
  };
  const readInfo = async (lock) => {
    const text = await io.readFile(join(lock, "info.json"));
    try {
      const info = text === undefined ? undefined : JSON.parse(text);
      if (!isDict(info))
        return;
      return {
        started: Number.isFinite(Number(info.started)) ? Number(info.started) : undefined,
        limit: Number(info.timeoutMs) || 0,
        key: typeof info.key === "string" ? info.key : undefined,
        files: Array.isArray(info.files) ? info.files.map(String) : undefined
      };
    } catch {
      return;
    }
  };
  const remainingMs = async (lock, info) => {
    const started = info?.started ?? (await io.stat(lock))?.mtimeMs ?? await io.now();
    return started + (info?.limit ?? 0) + GRACE_MS - await io.now();
  };
  const covers = (theirs) => theirs !== undefined && mine.every((f) => theirs.includes(f));
  const findRunning = async () => {
    let pending = false;
    for (const e of await io.list(dir)) {
      if (e.kind !== "dir" || !e.name.startsWith(keyPrefix) || !e.name.endsWith(".run"))
        continue;
      const lock = join(dir, e.name);
      const info = await readInfo(lock);
      const alive = await remainingMs(lock, info) > 0;
      if (!info) {
        if (alive)
          pending = true;
        continue;
      }
      if (info.key !== key || !covers(info.files))
        continue;
      if (!alive) {
        await io.removeTree(lock);
        continue;
      }
      return { lock, pending };
    }
    return { pending };
  };
  const readOutcome = async (resultFile) => {
    const text = await io.readFile(resultFile);
    if (text === undefined)
      return;
    try {
      const r = JSON.parse(text);
      if (!isDict(r) || r.key !== key || !Array.isArray(r.files) || !covers(r.files.map(String)))
        return;
      return { out: String(r.out ?? ""), ok: r.ok === true, timedOut: r.timedOut === true, logpath: String(r.logpath ?? "") };
    } catch {
      return;
    }
  };
  let announced = false;
  for (let round = 0;round < MAX_ROUNDS; round++) {
    const found = await findRunning();
    if (!found.lock && found.pending) {
      await io.run(["sleep", POLL_SECONDS]);
      round--;
      continue;
    }
    let target = found.lock;
    if (!target) {
      if (await claim())
        return { outcome: await lead(), shared: false };
      target = ownLock;
    }
    const left = await remainingMs(target, await readInfo(target));
    if (left <= 0) {
      await io.removeTree(target);
      continue;
    }
    if (!announced) {
      announced = true;
      await hooks.onWait?.();
    }
    await io.run(["sh", "-c", `while [ -d "$1" ]; do sleep ${POLL_SECONDS}; done`, "sh", target], { timeoutMs: Math.min(Math.max(left, 1), MAX_WAIT_MS) });
    if (await io.exists(target))
      continue;
    const outcome = await readOutcome(resultOf(target));
    if (outcome)
      return { outcome, shared: true };
  }
  return { outcome: await execute(), shared: false };
}

// src/gate.ts
var MAX_ATTEMPTS2 = 5;
var DEFAULT_TIMEOUT = 300;
var LOG_MAX_AGE = 3600;
var LOG_STALE_GRACE = 300;
var TRACE_WINDOW = 86400;
var POLICY_TIMEOUT = 30;
var FILES_ENV_KEY = "CLAUDE_GATE_FILES";
var DOGWOOD_FALLBACKS = ["~/.cargo/bin/dogwood", "~/.local/share/mise/shims/dogwood"];
var GATE_PRINCIPAL = 'Gate::Agent::"gate"';
var STATUS_CMD_MAX = 100;
var FAIL_TAIL_LINES = 60;
var FAIL_DETAIL_MAX = 12000;
var UNMATCHED_SHOWN = 5;
var MAX_TIMEOUT_MS = 600000;
var mk = (root, rel) => `${root}\x00${rel}`;
var unmk = (k) => {
  const i = k.indexOf("\x00");
  return [k.slice(0, i), k.slice(i + 1)];
};
var sortedKeys = (s) => [...s].sort();
function normalizePerFileDirMode(value) {
  if (value === true || value === "file")
    return "file";
  if (value === "pattern_root")
    return "pattern_root";
  return null;
}
var fileRoot = (relPath) => dirname(relPath);
function patternRootSegmentCount(pattern) {
  const segs = pattern.split("/");
  for (let i = 0;i < segs.length; i++) {
    const seg = segs[i];
    if (seg.length >= 2 && /^\*+$/.test(seg))
      return i;
  }
  return null;
}
function globMatchRoot(pattern, relPath) {
  const idx = patternRootSegmentCount(pattern);
  if (idx === null)
    return dirname(relPath);
  return relPath.split("/").slice(0, idx).join("/");
}
function computePerFileRoots(mode, patternPairs, matched) {
  const roots = {};
  if (mode === "file") {
    for (const rp of matched)
      roots[rp] = fileRoot(rp);
    return roots;
  }
  for (const rp of matched) {
    for (const [text, rx] of patternPairs) {
      if (rx.test(rp)) {
        roots[rp] = globMatchRoot(text, rp);
        break;
      }
    }
  }
  return roots;
}
var slug = (cmd) => cmd.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 80) || "cmd";
function oneLine(cmd) {
  const lines = String(cmd).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  let text = lines[0] ?? "";
  if (lines.length > 1)
    text += " ...";
  return text.length <= STATUS_CMD_MAX ? text : `${text.slice(0, STATUS_CMD_MAX - 3)}...`;
}
var filesEnv = (rels) => ({ [FILES_ENV_KEY]: [...new Set(rels)].sort().map(shellQuote).join(" ") });
function mergeFilesEnv(a, b) {
  const rels = new Set;
  for (const env of [a, b])
    if (env?.[FILES_ENV_KEY])
      for (const r of shellSplit(env[FILES_ENV_KEY]))
        rels.add(r);
  return { ...b, ...a, ...filesEnv(rels) };
}
var sameEnv = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
var cedarString = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replaceAll(`
`, "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
function traceLine(rec, project, index) {
  const resource = `Gate::Project::${cedarString(project)}`;
  const payload = `{ name: ${cedarString(rec.name || "")}, cmd: ${cedarString(rec.cmd || "")} }`;
  return `@${Math.trunc(Number(rec.ts) || 0)} scope(principal: ${GATE_PRINCIPAL}, resource: ${resource}) request_context(input: ${payload}) ` + `Gate::Action::"Run"::${rec.kind || "request"}(input: ${payload}, callerPrincipal: ${GATE_PRINCIPAL}, callerResource: ${resource}, ` + `requestId: ${cedarString(`r${index}`)})`;
}
function parseCmd(item, defaultTimeout) {
  if (isDict(item)) {
    return [
      truthy(item.cmd) ? item.cmd : "",
      truthy(item.timeout) ? item.timeout : defaultTimeout,
      truthy(item.name) ? String(item.name) : null
    ];
  }
  return [item, defaultTimeout, null];
}
var parseShare = (item) => !(isDict(item) && item.share === false);
var parseFiles = (item) => !(isDict(item) && item.files === false);
var agentEnv = (agentId) => agentId ? { CLAUDE_AGENT_ID: agentId } : {};
var AGENT_ENV_KEYS = Object.keys(agentEnv("-"));
function shareKey(root, cwd, cmd, env) {
  const shared = Object.entries(env).filter(([k]) => !AGENT_ENV_KEYS.includes(k) && k !== FILES_ENV_KEY).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([root, cwd, cmd, shared]);
}
var shareFiles = (env, files) => files && env[FILES_ENV_KEY] ? shellSplit(env[FILES_ENV_KEY]) : [];
var isParallel = (item) => isDict(item) && ("parallel" in item);
function summarizeCmds(cmds) {
  const parts = [];
  for (const c of cmds) {
    if (isParallel(c))
      parts.push(`(${summarizeCmds(c.parallel || []).replaceAll(" ; ", " & ")})`);
    else if (isDict(c))
      parts.push(truthy(c.cmd) ? String(c.cmd) : "");
    else
      parts.push(c);
  }
  return parts.join(" ; ");
}
function tailOutput(lang, out, limit = FAIL_TAIL_LINES) {
  const lines = out.trimEnd().split(/\r?\n/);
  if (lines.length <= limit)
    return lines.join(`
`);
  return [tr(lang)(GATE_HEAD_OMITTED, lines.length - limit), ...lines.slice(-limit)].join(`
`);
}
function failureDetails(lang, failures) {
  if (failures.length === 0)
    return "";
  const t = tr(lang);
  let text = "";
  let used = 0;
  let omitted = 0;
  for (const [i, original] of failures.entries()) {
    let d = original;
    if (used + d.length + 1 > FAIL_DETAIL_MAX && used) {
      omitted = failures.length - i;
      break;
    }
    if (used + d.length + 1 > FAIL_DETAIL_MAX)
      d = `${d.slice(0, FAIL_DETAIL_MAX)}
${t(GATE_REST_OMITTED)}`;
    text += `${d}
`;
    used += d.length + 1;
  }
  if (omitted)
    text += `${t(GATE_FAILURES_OMITTED, omitted)}
`;
  return text.trimEnd();
}
var locks = new Map;
function withLock(path, fn) {
  const prev = locks.get(path) ?? Promise.resolve();
  const run = prev.then(fn);
  locks.set(path, run.then(() => {
    return;
  }, () => {
    return;
  }));
  return run;
}
var logSeq = 0;
var UNSET = Symbol("unset");

class PolicyState {
  executed = false;
  deferredThisRun = new Set;
  allowedThisRun = new Set;
}

class Gate {
  io;
  t;
  projectDir;
  sessionId;
  agentId;
  stateId;
  phase;
  stopHookActive;
  claudeDir;
  action;
  gateYml;
  stateDir;
  changed;
  count;
  sidecar;
  pending;
  reported;
  trace;
  deferred;
  logRoot;
  logDir;
  defaultPolicy;
  defaultPolicySchema;
  baseEnv;
  status = [];
  failures = [];
  stdout = "";
  stderr = "";
  reportConsumed = false;
  running = [];
  stopTicking;
  runningOwner;
  ranThisRun = new Set;
  executedLabels = [];
  constructor(io, opts = {}) {
    this.io = io;
    this.t = tr(io.lang);
    this.projectDir = io.projectDir || io.cwd;
    this.sessionId = opts.sessionId || "unknown";
    this.agentId = opts.agentId || "";
    this.stateId = this.agentId ? `${this.sessionId}--${this.agentId}` : this.sessionId;
    this.phase = (opts.phase || "checks").trim().toLowerCase();
    this.stopHookActive = opts.stopHookActive === true;
    this.claudeDir = join(this.projectDir, ".claude");
    this.action = join(this.claudeDir, "gate.yaml");
    this.gateYml = join(this.claudeDir, "gate.yml");
    this.stateDir = gateStatusDir(io);
    this.runningOwner = `${this.stateId}.${Math.random().toString(36).slice(2, 10)}`;
    this.changed = join(this.stateDir, `changed_files.${this.stateId}.txt`);
    this.count = join(this.stateDir, `gate_attempts.${this.stateId}.txt`);
    this.sidecar = join(this.stateDir, `gate_passed.${this.stateId}.txt`);
    this.pending = join(this.stateDir, `gate_pending_checks.${this.stateId}.json`);
    this.reported = join(this.stateDir, `gate_reported.${this.stateId}.txt`);
    this.trace = join(this.stateDir, `gate_trace.${this.stateId}.jsonl`);
    this.deferred = join(this.stateDir, `gate_deferred.${this.stateId}.json`);
    this.logRoot = join(this.stateDir, "logs");
    this.logDir = join(this.logRoot, this.stateId);
    this.defaultPolicy = join(io.pluginRoot, "scripts", "dogwood", "gate.default.dw");
    this.defaultPolicySchema = join(io.pluginRoot, "scripts", "dogwood", "gate.cedarschema");
    this.baseEnv = {
      CLAUDE_PROJECT_DIR: this.projectDir,
      CLAUDE_SESSION_ID: this.sessionId,
      CLAUDE_STOP_HOOK_ACTIVE: this.stopHookActive ? "true" : "false",
      CLAUDE_GATE_PHASE: this.phase,
      ...agentEnv(this.agentId)
    };
  }
  print(obj) {
    this.stdout += `${JSON.stringify(obj)}
`;
  }
  writeErr(text) {
    this.stderr += text;
  }
  async cleanup(only) {
    await this.io.removeFiles(only ?? [this.changed, this.count, this.sidecar, this.pending, this.reported]);
  }
  async rm(path) {
    await this.io.removeFiles([path]);
  }
  async pruneDir(dirpath, maxAge, rmdir = false) {
    const cutoff = await this.io.now() - maxAge * 1000;
    const entries = await this.io.list(dirpath);
    const old = entries.filter((e) => e.name.endsWith(".log") && e.kind === "file" && e.mtimeMs < cutoff).map((e) => join(dirpath, e.name));
    if (old.length > 0)
      await this.io.removeFiles(old);
    if (rmdir)
      await this.io.removeDir(dirpath);
  }
  async pruneShared() {
    const now = await this.io.now();
    const stale = async (dir, suffix, maxAge) => {
      const old = (await this.io.list(join(this.stateDir, dir))).filter((e) => e.kind === "file" && e.name.endsWith(suffix) && e.mtimeMs < now - maxAge * 1000).map((e) => join(this.stateDir, dir, e.name));
      if (old.length > 0)
        await this.io.removeFiles(old);
    };
    await stale("shared", ".result.json", LOG_STALE_GRACE);
    await stale("running", ".json", LOG_MAX_AGE);
  }
  async pruneLogs() {
    await this.pruneShared();
    for (const e of await this.io.list(this.logRoot)) {
      const path = join(this.logRoot, e.name);
      if (e.kind === "dir") {
        if (e.name === this.stateId)
          await this.pruneDir(path, LOG_MAX_AGE);
        else
          await this.pruneDir(path, LOG_STALE_GRACE, true);
      } else if (e.name.endsWith(".log") && e.kind === "file") {
        if (e.mtimeMs < await this.io.now() - LOG_STALE_GRACE * 1000)
          await this.rm(path);
      }
    }
  }
  note(kind, label, cmd, detail = "") {
    this.status.push(`[gate] ${kind}: ${label} $ ${oneLine(cmd)}${detail ? ` ${detail}` : ""}`);
  }
  statusBlock(fallback = "") {
    return this.status.length > 0 ? this.status.join(`
`) : fallback;
  }
  async loadTrace() {
    const text = await this.io.readFile(this.trace) ?? "";
    const records = [];
    for (const line of text.split(`
`)) {
      const t = line.trim();
      if (!t)
        continue;
      try {
        const rec = JSON.parse(t);
        if (isDict(rec))
          records.push(rec);
      } catch {}
    }
    return records;
  }
  async readTrace(root) {
    if (!await this.io.exists(this.trace))
      return [];
    const records = await withLock(this.trace, () => this.loadTrace());
    return records.filter((r) => r.root === root).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  }
  async appendTrace(root, cwd, name, cmd, kind) {
    const now = Math.floor(await this.io.now() / 1000);
    return withLock(this.trace, async () => {
      const records = await this.loadTrace();
      const last = Math.max(0, ...records.filter((r) => r.root === root).map((r) => Number(r.ts) || 0));
      const ts = Math.max(now, last);
      records.push({ ts, root, cwd, name, cmd, kind });
      const kept = records.filter((r) => (Number(r.ts) || 0) >= now - TRACE_WINDOW);
      await this.io.writeFile(this.trace, kept.map((r) => `${JSON.stringify(r)}
`).join(""));
      return ts;
    });
  }
  async loadDeferred() {
    const text = await this.io.readFile(this.deferred) || "[]";
    try {
      const entries = JSON.parse(text);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }
  dumpDeferred(entries) {
    return this.io.writeFile(this.deferred, JSON.stringify(entries));
  }
  async deferCmd(root, cwd, name, cmd, timeout, label, extraEnv) {
    await withLock(this.deferred, async () => {
      const entries = await this.loadDeferred();
      for (const e of entries) {
        if (e.root === root && e.cwd === cwd && e.cmd === cmd) {
          const merged = mergeFilesEnv(e.env, extraEnv);
          if (!sameEnv(merged, e.env)) {
            e.env = merged;
            await this.dumpDeferred(entries);
          }
          return;
        }
      }
      entries.push({ root, cwd, name, cmd, timeout, label, env: extraEnv ?? {} });
      await this.dumpDeferred(entries);
    });
  }
  async undeferCmd(root, cwd, cmd) {
    if (!await this.io.exists(this.deferred))
      return;
    await withLock(this.deferred, async () => {
      const entries = await this.loadDeferred();
      const kept = entries.filter((e) => !(e.root === root && e.cwd === cwd && e.cmd === cmd));
      if (kept.length !== entries.length)
        await this.dumpDeferred(kept);
    });
  }
  async takeDeferred() {
    if (!await this.io.exists(this.deferred))
      return [];
    return withLock(this.deferred, async () => {
      const entries = await this.loadDeferred();
      await this.dumpDeferred([]);
      return entries;
    });
  }
  static deferKey = (e) => `${e.root}\x00${e.cwd}\x00${e.cmd}`;
  async deferredKeys() {
    if (!await this.io.exists(this.deferred))
      return new Set;
    const entries = await withLock(this.deferred, () => this.loadDeferred());
    return new Set(entries.map(Gate.deferKey));
  }
  async takeDeferredMatching(keys) {
    if (!await this.io.exists(this.deferred))
      return [];
    return withLock(this.deferred, async () => {
      const entries = await this.loadDeferred();
      const matched = [];
      const kept = [];
      for (const e of entries)
        (keys.has(Gate.deferKey(e)) ? matched : kept).push(e);
      if (matched.length > 0)
        await this.dumpDeferred(kept);
      return matched;
    });
  }
  async resolveDogwood() {
    const explicit = this.io.env.DOGWOOD_BIN;
    if (explicit)
      return await this.io.isExecutable(explicit) ? explicit : undefined;
    const found = await which(this.io, "dogwood");
    if (found)
      return found;
    for (const candidate of DOGWOOD_FALLBACKS) {
      const path = expandUser(candidate, this.io.env.HOME);
      if (await this.io.isExecutable(path))
        return path;
    }
    return;
  }
  resolvePolicyPath(rootDir, value) {
    if (!truthy(value))
      return null;
    const path = expandUser(String(value), this.io.env.HOME);
    return isAbsolute(path) ? path : normpath(join(rootDir, path));
  }
  inheritedSetting(cfg, owner, key) {
    for (const src of [owner || {}, cfg || {}])
      if (key in src)
        return src[key];
    return UNSET;
  }
  async policyPaths(cfg, owner, rootDir, logs) {
    const value = this.inheritedSetting(cfg, owner, "policy");
    if (value === false)
      return null;
    const isDefault = value === UNSET || value === null || value === undefined;
    const policy = isDefault ? this.defaultPolicy : this.resolvePolicyPath(rootDir, value);
    if (!policy || !await this.io.exists(policy)) {
      if (!isDefault && policy && logs) {
        logs.push(this.t(GATE_POLICY_NOT_FOUND, policy));
      }
      return null;
    }
    const schema = this.resolvePolicyPath(rootDir, owner?.policy_schema || cfg?.policy_schema);
    return { policy, schema: schema || this.defaultPolicySchema, isDefault };
  }
  async dogwoodVerdict(policy, schema, rootDir, name, cmd) {
    const binpath = await this.resolveDogwood();
    if (!binpath)
      return [null, this.t(DOGWOOD_NOT_FOUND)];
    const history = await this.readTrace(rootDir);
    const lastTs = history.length > 0 ? Number(history[history.length - 1]?.ts) || 0 : 0;
    const now = await this.io.now();
    const request = { ts: Math.max(Math.floor(now / 1000), lastTs), name, cmd, kind: "request" };
    const project = basename(normpath(rootDir)) || "project";
    const tracefile = join(this.stateDir, `.dogwood-${now}-${logSeq++}.trace`);
    let r;
    try {
      await this.io.writeFile(tracefile, [...history, request].map((rec, i) => `${traceLine(rec, project, i)}
`).join(""));
      r = await this.io.run([binpath, "replay", policy, "--policy-schema", schema, "--trace", tracefile, "--format", "json"], {
        timeoutMs: POLICY_TIMEOUT * 1000
      });
    } finally {
      await this.rm(tracefile);
    }
    if (r.error !== undefined || r.timedOut) {
      return [null, this.t(DOGWOOD_RUN_FAILED, r.error ?? "timed out")];
    }
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || "").trim().replaceAll(`
`, " ").slice(0, 200);
      return [null, this.t(DOGWOOD_EXITED, r.exitCode, detail)];
    }
    let verdicts;
    try {
      const parsed = JSON.parse(r.stdout);
      const v = isDict(parsed) ? parsed.verdicts : undefined;
      verdicts = Array.isArray(v) ? v : [];
    } catch {
      return [null, this.t(DOGWOOD_BAD_JSON)];
    }
    if (verdicts.length === 0)
      return [null, this.t(DOGWOOD_NO_VERDICT)];
    const last = verdicts[verdicts.length - 1];
    const verdict = String((isDict(last) ? last.verdict : "") || "").toLowerCase();
    if (verdict !== "allow" && verdict !== "deny")
      return [null, this.t(DOGWOOD_BAD_VERDICT, pyRepr(verdict))];
    return [verdict, null];
  }
  async makePolicyContext(cfg, owner, rootDir, state, logs) {
    if (!state)
      return null;
    const resolved = await this.policyPaths(cfg, owner, rootDir, logs);
    if (!resolved)
      return null;
    return new PolicyContext(this, rootDir, resolved.policy, resolved.schema, resolved.isDefault, state);
  }
  async runCmd(cmd, cwd, timeout, name, extraEnv) {
    const uid = `${Math.floor(await this.io.now() / 1000)}-${logSeq++}`;
    const logpath = join(this.logDir, `${slug(name || cmd)}.${uid}.log`);
    const header = `$ ${cmd}  (cwd: ${cwd})
`;
    await this.io.writeFile(logpath, header).catch(() => {
      return;
    });
    const started = await this.io.now();
    const r = await this.io.run(["sh", "-c", `exec 2>&1; ${cmd}`], {
      cwd,
      env: { ...this.baseEnv, ...extraEnv },
      timeoutMs: Math.min(Math.round(timeout * 1000), MAX_TIMEOUT_MS)
    });
    const elapsed = await this.io.now() - started;
    const timedOut = r.timedOut || r.error !== undefined && elapsed >= Math.min(timeout * 1000, MAX_TIMEOUT_MS) - 1000;
    let out = r.stdout + r.stderr;
    if (r.error !== undefined && !timedOut)
      out += `${out && !out.endsWith(`
`) ? `
` : ""}${r.error}
`;
    await this.io.writeFile(logpath, header + out).catch(() => {
      return;
    });
    return { out, ok: r.exitCode === 0 && !timedOut && r.error === undefined, timedOut, logpath };
  }
  async runCmdShared(cmd, cwd, timeout, name, extraEnv, scope, onWait) {
    if (scope.share === false)
      return this.runCmd(cmd, cwd, timeout, name, extraEnv);
    const env = { ...this.baseEnv, ...extraEnv };
    const key = shareKey(scope.root, cwd, cmd, env);
    const r = await runShared(this.io, key, shareFiles(env, scope.files !== false), Math.min(Math.round(timeout * 1000), MAX_TIMEOUT_MS), () => this.runCmd(cmd, cwd, timeout, name, extraEnv), {
      onWait
    });
    if (!r.shared)
      return r.outcome;
    const uid = `${Math.floor(await this.io.now() / 1000)}-${logSeq++}`;
    const logpath = join(this.logDir, `${slug(name || cmd)}.${uid}.log`);
    const header = `$ ${cmd}  (cwd: ${cwd})
${this.t(GATE_SHARED_RESULT, r.outcome.logpath)}
`;
    await this.io.writeFile(logpath, header + r.outcome.out).catch(() => {
      return;
    });
    return { ...r.outcome, logpath };
  }
  async showRunning(name, cmd, started) {
    if (!this.io.redraw)
      return { waiting: async () => {
        return;
      }, done: async () => {
        return;
      } };
    const entry = { name: name || undefined, cmd, started };
    this.running.push(entry);
    if (!this.stopTicking)
      this.stopTicking = this.io.every?.(1000, () => this.io.redraw?.());
    this.io.result?.(undefined);
    await clearSummary(this.io, this.sessionId);
    await this.publishAndRedraw();
    return {
      waiting: async () => {
        entry.waiting = true;
        await this.publishAndRedraw();
      },
      done: async (ok) => {
        entry.result = ok ? "ok" : "fail";
        entry.ended = await this.io.now();
        entry.waiting = false;
        if (this.running.every((r) => r.result))
          this.stopTicker();
        await this.publishAndRedraw();
        const summary = finishedSummary(await listRunning(this.io, this.sessionId), this.io.lang);
        if (summary !== undefined) {
          this.io.result?.(summary);
          await saveSummary(this.io, this.sessionId, summary);
        }
      }
    };
  }
  stopTicker() {
    this.stopTicking?.();
    this.stopTicking = undefined;
  }
  async finishProgress() {
    this.stopTicker();
    this.running.length = 0;
    await withdrawRunning(this.io, this.runningOwner);
    this.io.redraw?.();
  }
  async publishAndRedraw() {
    await publishRunning(this.io, this.runningOwner, this.running);
    this.io.redraw?.();
  }
  async execOne(label, cmd, cwd, timeout, mark = "", name, extraEnv, scope = { root: this.projectDir }) {
    const title = name ? `${name}: ${cmd}` : cmd;
    const chunk = { lines: [`=== [gate] (${label})${mark} $ ${title} ===`] };
    const started = await this.io.now();
    const progress = await this.showRunning(name, cmd, started);
    let ran;
    let passed = false;
    try {
      ran = await this.runCmdShared(cmd, cwd, timeout, name, extraEnv, scope, progress.waiting);
      passed = ran.ok;
    } finally {
      await progress.done(passed);
    }
    this.ranThisRun.add(Gate.deferKey({ root: scope.root, cwd, cmd }));
    await this.undeferCmd(scope.root, cwd, cmd);
    const { out, ok, timedOut, logpath } = ran;
    this.executedLabels.push(name || oneLine(cmd));
    this.note(ok ? "ok" : "fail", label, cmd, `(${((await this.io.now() - started) / 1000).toFixed(1)}s)`);
    const detail = [chunk.lines[0]];
    if (out) {
      chunk.lines.push(out.trimEnd());
      detail.push(tailOutput(this.io.lang, out));
    }
    if (timedOut) {
      const msg = this.t(GATE_TIMEOUT, timeout);
      chunk.lines.push(msg);
      detail.push(msg);
    }
    if (!ok) {
      chunk.lines.push(`[gate] log: ${logpath}`);
      detail.push(`[gate] log: ${logpath}`);
      chunk.detail = detail.join(`
`);
    }
    return [chunk, ok];
  }
  collectFailure(chunk) {
    if (chunk.detail)
      this.failures.push(chunk.detail);
  }
  withDetails(prefix) {
    const details = failureDetails(this.io.lang, this.failures);
    return prefix + (details ? `

${this.t(GATE_FAILED_OUTPUT_HEADER)}
${details}` : "");
  }
  async runParallel(label, items, cwd, defaultTimeout, logs, policy, extraEnv, root = policy?.rootDir ?? this.projectDir) {
    let failed = false;
    const tasks = [];
    for (const item of items) {
      if (isParallel(item)) {
        logs.push(this.t(GATE_NESTED_PARALLEL, label));
        failed = true;
        continue;
      }
      const [cmd, timeout, name] = parseCmd(item, defaultTimeout);
      if (!cmd)
        continue;
      if (policy && !await policy.allows(label, cwd, cmd, timeout, name, logs, extraEnv))
        continue;
      tasks.push([cmd, timeout, name, { root, share: parseShare(item), files: parseFiles(item) }]);
    }
    if (tasks.length === 0)
      return failed;
    const results = await Promise.all(tasks.map((t) => this.execOne(label, t[0], cwd, t[1], " [parallel]", t[2], extraEnv, t[3])));
    for (const [i, [chunk, ok]] of results.entries()) {
      const [cmd, , name] = tasks[i];
      logs.push(...chunk.lines);
      this.collectFailure(chunk);
      if (policy)
        await policy.record(cwd, cmd, name, ok);
      if (!ok)
        failed = true;
    }
    return failed;
  }
  async runCmds(label, cmds, cwd, defaultTimeout, logs, policy, extraEnv, root = policy?.rootDir ?? this.projectDir) {
    let failed = false;
    for (const item of cmds) {
      if (isParallel(item)) {
        if (await this.runParallel(label, item.parallel || [], cwd, defaultTimeout, logs, policy, extraEnv, root))
          failed = true;
        continue;
      }
      const [cmd, timeout, name] = parseCmd(item, defaultTimeout);
      if (!cmd)
        continue;
      if (policy && !await policy.allows(label, cwd, cmd, timeout, name, logs, extraEnv))
        continue;
      const [chunk, ok] = await this.execOne(label, cmd, cwd, timeout, "", name, extraEnv, { root, share: parseShare(item), files: parseFiles(item) });
      logs.push(...chunk.lines);
      this.collectFailure(chunk);
      if (policy)
        await policy.record(cwd, cmd, name, ok);
      if (!ok)
        failed = true;
    }
    return failed;
  }
  async runDeferred(entries, logs) {
    const summary = [];
    const failed = [];
    for (const entry of entries) {
      const cmd = entry.cmd || "";
      const cwd = entry.cwd || "";
      if (!cmd)
        continue;
      const label = `deferred:${entry.label || "."}`;
      if ((await this.io.stat(cwd))?.kind !== "dir") {
        logs.push(this.t(GATE_DEFERRED_NO_CWD, label, cwd));
        continue;
      }
      const name = entry.name || slug(cmd);
      summary.push(`(${label}) ${cmd}`);
      const [chunk, ok] = await this.execOne(label, cmd, cwd, entry.timeout || DEFAULT_TIMEOUT, "", name, entry.env, { root: entry.root || this.projectDir });
      logs.push(...chunk.lines);
      this.collectFailure(chunk);
      await this.appendTrace(entry.root || this.projectDir, cwd, name, cmd, ok ? "response" : "error");
      if (!ok)
        failed.push(entry);
    }
    return [summary, failed];
  }
  async requeueDeferred(entries) {
    for (const e of entries)
      await this.deferCmd(e.root, e.cwd, e.name, e.cmd, e.timeout, e.label, e.env);
  }
  splitRoot(raw) {
    return splitRoot(this.projectDir, raw);
  }
  async loadChangedFlat(path) {
    const text = await this.io.readFile(path);
    const order = [];
    const rawByKey = new Map;
    if (text === undefined)
      return { order, rawByKey };
    for (const raw of text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")) {
      const key = mk(...this.splitRoot(raw));
      if (!rawByKey.has(key)) {
        rawByKey.set(key, raw);
        order.push(key);
      }
    }
    return { order, rawByKey };
  }
  async writeChangedFlat(path, keys, rawByKey) {
    if (keys.length === 0)
      return this.rm(path);
    await this.io.writeFile(path, keys.map((k) => `${rawByKey.get(k)}
`).join(""));
  }
  groupKeysByRoot(keys) {
    const order = [];
    const relsByRoot = new Map;
    for (const k of keys) {
      const [root, rel] = unmk(k);
      let list = relsByRoot.get(root);
      if (!list) {
        list = [];
        relsByRoot.set(root, list);
        order.push(root);
      }
      list.push(rel);
    }
    return { order, relsByRoot };
  }
  async loadRootCfg(root, mainCfg) {
    const path = join(root, ".claude", "gate.yaml");
    return await this.io.exists(path) ? await this.loadAction(path) : mainCfg;
  }
  async loadAction(path) {
    const text = await this.io.readFile(path);
    if (text === undefined)
      throw new Error(this.t(GATE_CANNOT_READ_YAML, path));
    return parseYaml(text);
  }
  noteUnmatchedFiles(rels, triggered) {
    const covered = new Set;
    for (const t of triggered)
      for (const m of t.matched)
        covered.add(m);
    const unmatched = [...new Set(rels)].filter((r) => !covered.has(r)).sort();
    if (unmatched.length === 0)
      return;
    const shown = unmatched.slice(0, UNMATCHED_SHOWN).join(", ");
    const more = unmatched.length > UNMATCHED_SHOWN ? this.t(GATE_AND_MORE, unmatched.length - UNMATCHED_SHOWN) : "";
    this.status.push(this.t(GATE_SKIP_UNMATCHED, `${shown}${more}`));
  }
  async runRules(cfg, rels, logs, rootDir, policyState) {
    const rules = cfg?.rules || [];
    const triggered = [];
    for (const rule of rules) {
      const m = rule.match;
      const pats = typeof m === "string" ? [m] : truthy(m) ? m : [];
      const pairs = matchPatterns(pats);
      const matched = [...new Set(rels.filter((rp) => pairs.some(([, rx]) => rx.test(rp))))].sort();
      if (matched.length > 0)
        triggered.push({ rule, matched, pairs });
    }
    const summary = [];
    let failed = false;
    const successFiles = new Set;
    const failFiles = new Set;
    const checkNames = [];
    const checkRefFiles = new Map;
    for (const { rule, matched, pairs } of triggered) {
      const cmds = rule.run || [];
      const timeout = rule.timeout || DEFAULT_TIMEOUT;
      const policy = await this.makePolicyContext(cfg, rule, rootDir, policyState, logs);
      const ruleFiles = new Set(matched);
      for (const name of rule.run_checks || []) {
        let set = checkRefFiles.get(name);
        if (!set) {
          set = new Set;
          checkRefFiles.set(name, set);
        }
        for (const f of ruleFiles)
          set.add(f);
        if (!checkNames.includes(name))
          checkNames.push(name);
      }
      const rawPerFileDir = rule.per_file_dir;
      if (truthy(rawPerFileDir)) {
        const mode = normalizePerFileDirMode(rawPerFileDir);
        if (mode === null) {
          logs.push(this.t(GATE_BAD_PER_FILE_DIR, pyRepr(rawPerFileDir)));
          summary.push(`${summarizeCmds(cmds)}  ${this.t(GATE_SKIP_BAD_PER_FILE_DIR)}`);
          failed = true;
          for (const f of ruleFiles)
            failFiles.add(f);
          continue;
        }
        const rootsByRel = computePerFileRoots(mode, pairs, matched);
        for (const d of [...new Set(Object.values(rootsByRel))].sort()) {
          const cwd = d ? join(rootDir, d) : rootDir;
          const label = d || ".";
          const dirFiles = matched.filter((rp) => rootsByRel[rp] === d);
          if ((await this.io.stat(cwd))?.kind !== "dir") {
            logs.push(this.t(GATE_ROOT_NO_CWD, label, cwd));
            summary.push(`(${label}) ${summarizeCmds(cmds)}  ${this.t(GATE_SKIP_NO_CWD)}`);
            this.note("skip", label, summarizeCmds(cmds), this.t(GATE_NOTE_NO_CWD));
            continue;
          }
          summary.push(`(${label}) ${summarizeCmds(cmds)}`);
          if (await this.runCmds(label, cmds, cwd, timeout, logs, policy, filesEnv(dirFiles), rootDir)) {
            failed = true;
            for (const f of dirFiles)
              failFiles.add(f);
          } else {
            for (const f of dirFiles)
              successFiles.add(f);
          }
        }
      } else {
        const cwd = rule.dir ? join(rootDir, rule.dir) : rootDir;
        const label = rule.dir ?? ".";
        if ((await this.io.stat(cwd))?.kind !== "dir") {
          logs.push(this.t(GATE_RULE_NO_CWD, label, cwd));
          summary.push(`(${label}) ${summarizeCmds(cmds)}  ${this.t(GATE_SKIP_NO_CWD)}`);
          this.note("skip", label, summarizeCmds(cmds), this.t(GATE_NOTE_NO_CWD));
          continue;
        }
        summary.push(`(${label}) ${summarizeCmds(cmds)}`);
        if (await this.runCmds(label, cmds, cwd, timeout, logs, policy, filesEnv(ruleFiles), rootDir)) {
          failed = true;
          for (const f of ruleFiles)
            failFiles.add(f);
        } else {
          for (const f of ruleFiles)
            successFiles.add(f);
        }
      }
    }
    this.noteUnmatchedFiles(rels, triggered);
    return { summary, failed, successFiles, failFiles, checkNames, checkRefFiles };
  }
  async runRulesAllRoots(rootOrder, relsByRoot, mainCfg, logs, policyState) {
    const summary = [];
    let failed = false;
    const successKeys = new Set;
    const failKeys = new Set;
    const consumedKeys = new Set;
    const checkNamesByRoot = new Map;
    const checkRefKeysByRoot = new Map;
    for (const root of rootOrder) {
      const rels = relsByRoot.get(root) || [];
      if (rels.length === 0)
        continue;
      if (root !== this.projectDir && (await this.io.stat(root))?.kind !== "dir") {
        logs.push(this.t(GATE_WORKTREE_NOT_FOUND, root));
        for (const rp of rels)
          consumedKeys.add(mk(root, rp));
        continue;
      }
      const cfg = root === this.projectDir ? mainCfg : await this.loadRootCfg(root, mainCfg);
      const prefix = root === this.projectDir ? "" : `[${relpath(root, this.projectDir)}] `;
      const r = await this.runRules(cfg, rels, logs, root, policyState);
      summary.push(...r.summary.map((s) => prefix + s));
      if (r.failed)
        failed = true;
      for (const rp of r.successFiles)
        successKeys.add(mk(root, rp));
      for (const rp of r.failFiles)
        failKeys.add(mk(root, rp));
      if (r.checkNames.length > 0) {
        checkNamesByRoot.set(root, r.checkNames);
        const refs = new Map;
        for (const [name, files] of r.checkRefFiles)
          refs.set(name, new Set([...files].map((rp) => mk(root, rp))));
        checkRefKeysByRoot.set(root, refs);
      }
    }
    return { summary, failed, successKeys, failKeys, consumedKeys, checkNamesByRoot, checkRefKeysByRoot };
  }
  async loadPending() {
    const text = await this.io.readFile(this.pending);
    if (text === undefined)
      return {};
    try {
      const v = JSON.parse(text);
      return isDict(v) && truthy(v) ? v : {};
    } catch {
      return {};
    }
  }
  async savePending(data) {
    if (Object.keys(data).length === 0)
      return this.rm(this.pending);
    await this.io.writeFile(this.pending, JSON.stringify(data));
  }
  async mergePendingChecks(checkNamesByRoot, checkRefKeysByRoot, rawByKey) {
    if (checkNamesByRoot.size === 0)
      return;
    const data = await this.loadPending();
    for (const [root, names] of checkNamesByRoot) {
      const rootChecks = data[root] ?? {};
      data[root] = rootChecks;
      const ref = checkRefKeysByRoot.get(root);
      for (const name of names) {
        const raws = [...ref?.get(name) ?? []].map((k) => rawByKey.get(k));
        rootChecks[name] = [...new Set([...rootChecks[name] || [], ...raws])].sort();
      }
    }
    await this.savePending(data);
  }
  async runRulesPhase() {
    if (!(await this.io.exists(this.action) && await this.io.exists(this.changed)))
      return 0;
    const { order, rawByKey } = await this.loadChangedFlat(this.changed);
    if (order.length === 0) {
      await this.rm(this.changed);
      return 0;
    }
    const cfg = await this.loadAction(this.action);
    const rules = cfg?.rules || [];
    if (rules.length === 0) {
      await this.rm(this.changed);
      return 0;
    }
    const logs = [];
    const policyState = new PolicyState;
    const keysBeforeThisRun = await this.deferredKeys();
    const { order: rootOrder, relsByRoot } = this.groupKeysByRoot(order);
    const res = await this.runRulesAllRoots(rootOrder, relsByRoot, cfg, logs, policyState);
    const summary = res.summary;
    let failed = res.failed;
    if (policyState.executed) {
      const keysToDrain = new Set([...keysBeforeThisRun].filter((k) => !policyState.deferredThisRun.has(k)));
      const [deferredSummary, deferredFailed] = await this.runDeferred(await this.takeDeferredMatching(keysToDrain), logs);
      summary.push(...deferredSummary);
      if (deferredFailed.length > 0)
        failed = true;
    }
    if (res.checkNamesByRoot.size > 0)
      await this.mergePendingChecks(res.checkNamesByRoot, res.checkRefKeysByRoot, rawByKey);
    const checkedKeys = new Set;
    for (const ref of res.checkRefKeysByRoot.values())
      for (const keys of ref.values())
        for (const k of keys)
          checkedKeys.add(k);
    const remaining = [];
    const seen = new Set;
    const sidecarAdd = [];
    const seenSidecar = new Set;
    for (const k of order) {
      if (res.consumedKeys.has(k))
        continue;
      if (res.successKeys.has(k) && !res.failKeys.has(k)) {
        if (checkedKeys.has(k) && !seenSidecar.has(k)) {
          seenSidecar.add(k);
          sidecarAdd.push(k);
        }
        continue;
      }
      if (seen.has(k))
        continue;
      seen.add(k);
      remaining.push(k);
    }
    await this.writeChangedFlat(this.changed, remaining, rawByKey);
    if (sidecarAdd.length > 0) {
      const existing = await this.loadChangedFlat(this.sidecar);
      const merged = [...new Set([...existing.order, ...sidecarAdd])];
      const rawLookup = new Map([...existing.rawByKey, ...rawByKey]);
      await this.writeChangedFlat(this.sidecar, merged, rawLookup);
    }
    if (failed) {
      this.writeErr(`${[...this.status, ...logs].join(`
`)}
`);
      this.writeErr(`${this.t(GATE_RULES_FAILED)}
`);
      return 2;
    }
    if (summary.length > 0 || this.status.length > 0) {
      const body = this.statusBlock(summary.map((s) => `✓ ${s}`).join(`
`));
      this.print({ systemMessage: this.t(GATE_RULES_PASSED, body) });
    }
    return 0;
  }
  async runNamedChecks(checksByName, names, logs, rootDir, cfg, policyState, filesByName) {
    const summary = [];
    let failed = false;
    for (const name of [...names].sort()) {
      const check = checksByName.get(name);
      if (!check) {
        logs.push(this.t(GATE_CHECK_NOT_FOUND, name));
        summary.push(this.t(GATE_CHECK_NOT_FOUND_SUMMARY, name));
        this.status.push(this.t(GATE_SKIP_CHECK_UNDEFINED, name));
        continue;
      }
      const cwd = check.dir ? join(rootDir, check.dir) : rootDir;
      const cmds = check.run || [];
      const timeout = check.timeout || DEFAULT_TIMEOUT;
      if ((await this.io.stat(cwd))?.kind !== "dir") {
        logs.push(this.t(GATE_CHECK_NO_CWD, name, cwd));
        summary.push(`(check:${name}) ${summarizeCmds(cmds)}  ${this.t(GATE_SKIP_NO_CWD)}`);
        this.note("skip", `check:${name}`, summarizeCmds(cmds), this.t(GATE_NOTE_NO_CWD));
        continue;
      }
      summary.push(`(check:${name}) ${summarizeCmds(cmds)}`);
      const policy = await this.makePolicyContext(cfg, check, rootDir, policyState, logs);
      const refs = filesByName[name] || [];
      const env = filesEnv(refs.map((raw) => this.splitRoot(raw)[1]));
      if (await this.runCmds(`check:${name}`, cmds, cwd, timeout, logs, policy, env, rootDir))
        failed = true;
    }
    return [summary, failed];
  }
  pendingRefKeys(pending) {
    const keys = new Set;
    for (const checks of Object.values(pending))
      for (const raws of Object.values(checks))
        for (const raw of raws)
          keys.add(mk(...this.splitRoot(raw)));
    return keys;
  }
  pendingRawByKey(pending) {
    const m = new Map;
    for (const checks of Object.values(pending)) {
      for (const raws of Object.values(checks)) {
        for (const raw of raws) {
          const k = mk(...this.splitRoot(raw));
          if (!m.has(k))
            m.set(k, raw);
        }
      }
    }
    return m;
  }
  async confirmPending(pending) {
    const keys = this.pendingRefKeys(pending);
    if (keys.size === 0)
      return;
    const { order, rawByKey } = await this.loadChangedFlat(this.sidecar);
    await this.writeChangedFlat(this.sidecar, order.filter((k) => !keys.has(k)), rawByKey);
  }
  async requeuePendingToChanged(pending) {
    const keys = this.pendingRefKeys(pending);
    if (keys.size === 0)
      return;
    const sidecar = await this.loadChangedFlat(this.sidecar);
    await this.writeChangedFlat(this.sidecar, sidecar.order.filter((k) => !keys.has(k)), sidecar.rawByKey);
    const changed = await this.loadChangedFlat(this.changed);
    const rawLookup = new Map([...this.pendingRawByKey(pending), ...sidecar.rawByKey, ...changed.rawByKey]);
    const have = new Set(changed.order);
    const merged = [...new Set([...changed.order, ...sortedKeys([...keys].filter((k) => !have.has(k)))])];
    await this.writeChangedFlat(this.changed, merged, rawLookup);
  }
  async purgeRootsFromSidecar(droppedRoots) {
    if (droppedRoots.size === 0)
      return;
    const { order, rawByKey } = await this.loadChangedFlat(this.sidecar);
    await this.writeChangedFlat(this.sidecar, order.filter((k) => !droppedRoots.has(unmk(k)[0])), rawByKey);
  }
  async runChecksPhase() {
    if (await this.io.exists(this.reported)) {
      await this.rm(this.reported);
      if (this.stopHookActive) {
        this.reportConsumed = true;
        return 0;
      }
    }
    const pending = await this.io.exists(this.pending) ? await this.loadPending() : {};
    if (Object.keys(pending).length === 0)
      await this.rm(this.pending);
    const deferred = await this.takeDeferred();
    if (Object.keys(pending).length === 0 && deferred.length === 0)
      return 0;
    const mainCfg = await this.loadAction(this.action);
    const logs = [];
    const summary = [];
    let failed = false;
    const policyState = new PolicyState;
    const activePending = {};
    const droppedRoots = new Set;
    for (const [root, checksMap] of Object.entries(pending)) {
      if (root !== this.projectDir && (await this.io.stat(root))?.kind !== "dir") {
        logs.push(this.t(GATE_WORKTREE_NOT_FOUND, root));
        droppedRoots.add(root);
        continue;
      }
      activePending[root] = checksMap;
      const cfg = root === this.projectDir ? mainCfg : await this.loadRootCfg(root, mainCfg);
      const checksByName = new Map((cfg?.consistency_checks || []).map((c) => [c.name, c]));
      const prefix = root === this.projectDir ? "" : `[${relpath(root, this.projectDir)}] `;
      const [rSummary, rFailed] = await this.runNamedChecks(checksByName, Object.keys(checksMap), logs, root, cfg, policyState, checksMap);
      summary.push(...rSummary.map((s) => prefix + s));
      if (rFailed)
        failed = true;
    }
    await this.purgeRootsFromSidecar(droppedRoots);
    const remaining = deferred.filter((e) => !this.ranThisRun.has(Gate.deferKey(e)));
    const [dSummary, dFailed] = await this.runDeferred(remaining, logs);
    summary.push(...dSummary);
    if (dFailed.length > 0) {
      await this.requeueDeferred(dFailed);
      failed = true;
    }
    if (!failed) {
      await this.confirmPending(activePending);
      await this.cleanup([this.count, this.pending]);
      const body = this.statusBlock(summary.length > 0 ? summary.map((s) => `✓ ${s}`).join(`
`) : this.t(GATE_NOTHING_TO_RUN));
      if (this.executedLabels.length > 0 && !this.stopHookActive && mainCfg?.report_success !== false) {
        await this.io.writeFile(this.reported, `1
`);
        const reason = this.t(GATE_ALL_PASSED, this.executedLabels.map((l) => `${l} ✓`).join(" / "));
        this.writeErr(`${reason}
`);
        this.print({ decision: "block", reason });
        return 2;
      }
      const title = Object.keys(pending).length > 0 ? "consistency checks" : this.t(GATE_DEFERRED_TITLE);
      this.print({ systemMessage: this.t(GATE_CHECKS_PASSED, title, body) });
      return 0;
    }
    this.writeErr(`${[...this.status, ...logs].join(`
`)}
`);
    let attempts = 0;
    const countText = await this.io.readFile(this.count);
    if (countText !== undefined && /^\s*[+-]?\d+\s*$/.test(countText))
      attempts = Number.parseInt(countText.trim(), 10);
    if (!this.stopHookActive)
      attempts = 0;
    attempts += 1;
    await this.io.writeFile(this.count, String(attempts));
    if (attempts >= MAX_ATTEMPTS2) {
      await this.requeuePendingToChanged(activePending);
      await this.cleanup([this.count, this.pending]);
      this.writeErr(`${this.t(GATE_CHECKS_GAVE_UP_STDERR, MAX_ATTEMPTS2)}
`);
      const msg = `${this.t(GATE_CHECKS_GAVE_UP, MAX_ATTEMPTS2)}
${summary.map((s) => `✗ ${s}`).join(`
`)}${this.withDetails("")}`;
      this.print({ systemMessage: msg });
      return 0;
    }
    const reason = `${this.t(GATE_CHECKS_FAILED, attempts, MAX_ATTEMPTS2)}
${summary.map((s) => `✗ ${s}`).join(`
`)}${this.withDetails("")}`;
    this.writeErr(`${reason}
`);
    this.print({ decision: "block", reason });
    return 2;
  }
  async main() {
    await this.pruneLogs();
    if (!await this.io.exists(this.action) && await this.io.exists(this.gateYml)) {
      this.print({ systemMessage: this.t(GATE_YML_TYPO) });
    }
    if (!await this.io.exists(this.action)) {
      await this.cleanup();
      return 0;
    }
    return this.phase === "rules" ? this.runRulesPhase() : this.runChecksPhase();
  }
}

class PolicyContext {
  gate;
  rootDir;
  policy;
  schema;
  isDefault;
  state;
  constructor(gate, rootDir, policy, schema, isDefault, state) {
    this.gate = gate;
    this.rootDir = rootDir;
    this.policy = policy;
    this.schema = schema;
    this.isDefault = isDefault;
    this.state = state;
  }
  async allows(label, cwd, cmd, timeout, name, logs, extraEnv) {
    if (this.isDefault && !await this.gate.resolveDogwood())
      return true;
    const pname = name || slug(cmd);
    const [verdict, reason] = await this.gate.dogwoodVerdict(this.policy, this.schema, this.rootDir, pname, cmd);
    if (verdict === null) {
      logs.push(this.gate.t(GATE_POLICY_UNEVALUATED, label, reason ?? "", cmd));
    } else {
      await this.gate.appendTrace(this.rootDir, cwd, pname, cmd, "request");
      if (verdict === "allow") {
        await this.gate.undeferCmd(this.rootDir, cwd, cmd);
        this.state.executed = true;
        this.state.allowedThisRun.add(`${this.rootDir}\x00${cwd}\x00${cmd}`);
        return true;
      }
      logs.push(this.gate.t(GATE_POLICY_SKIPPED, label, cmd));
    }
    this.gate.note("skip", label, cmd, verdict ? this.gate.t(GATE_NOTE_POLICY_SKIPPED) : this.gate.t(GATE_NOTE_POLICY_UNEVALUATED, reason ?? ""));
    this.state.deferredThisRun.add(`${this.rootDir}\x00${cwd}\x00${cmd}`);
    await this.gate.deferCmd(this.rootDir, cwd, pname, cmd, timeout, label, extraEnv);
    return false;
  }
  async record(cwd, cmd, name, ok) {
    await this.gate.appendTrace(this.rootDir, cwd, name || slug(cmd), cmd, ok ? "response" : "error");
  }
}
async function runGate(io, opts = {}) {
  const gate = new Gate(io, opts);
  let exitCode;
  try {
    exitCode = await gate.main();
  } catch (e) {
    gate.stderr += `[gate] internal error:
${e instanceof Error ? e.stack ?? e.message : String(e)}
`;
    gate.stdout += `${JSON.stringify({ systemMessage: tr(io.lang)(GATE_INTERNAL_ERROR) })}
`;
    exitCode = 0;
  } finally {
    await gate.finishProgress();
  }
  return { exitCode, stdout: gate.stdout, stderr: gate.stderr, ...gate.reportConsumed ? { reportConsumed: true } : {} };
}

// src/stop-test-gate.ts
async function stopTestGate(io, phase, payload) {
  const projectDir = io.projectDir || io.cwd;
  if (!await io.exists(join(projectDir, ".claude", "gate.yaml"))) {
    if (await io.exists(join(projectDir, ".claude", "gate.yml"))) {
      return ok(`${JSON.stringify({ systemMessage: tr(io.lang)(GATE_YML_TYPO) })}
`);
    }
    return ok();
  }
  return runGate(io, {
    sessionId: jqStr(payload.session_id) || "unknown",
    agentId: jqStr(payload.agent_id),
    phase: phase || "checks",
    stopHookActive: payload.stop_hook_active === true
  });
}

// src/all-stop.ts
async function allStop(io, payload) {
  let stdout = "";
  let stderr = "";
  let reportConsumed = false;
  for (const step of [() => stopTestGate(io, "checks", payload), () => feedbackStopCheck(io, payload)]) {
    const r = await step();
    stdout += r.stdout;
    stderr += r.stderr;
    if (r.exitCode !== 0)
      return { exitCode: r.exitCode, stdout, stderr };
    if (r.reportConsumed)
      reportConsumed = true;
  }
  if (payload.stop_hook_active !== true || reportConsumed) {
    const r = await notification(io, "stop", payload);
    stdout += r.stdout;
    stderr += r.stderr;
  }
  return { exitCode: 0, stdout, stderr };
}

// src/bash-changes.ts
var SKIP_COMMAND_RE = /\bgit\b[^|;&\n]*\b(rebase|checkout|switch|merge|pull|stash|reset|cherry-pick|revert|restore|clean|am|apply|worktree)\b/;
var MTIME_SLACK_MS = 2000;
var STATE_DIR = ".gate-status";
var stateIdOf = (payload) => {
  const sessionId = jqStr(payload.session_id) || "unknown";
  const agentId = jqStr(payload.agent_id);
  return agentId ? `${sessionId}--${agentId}` : sessionId;
};
var startedPath = (projectDir, stateId) => join(projectDir, ".claude", STATE_DIR, `bash_started.${stateId}.json`);
async function bashStarted(io, payload) {
  try {
    const projectDir = io.projectDir || io.cwd;
    if (!await io.exists(join(projectDir, ".claude", "gate.yaml")))
      return ok();
    const started = await io.now();
    await io.writeFile(startedPath(projectDir, stateIdOf(payload)), `${JSON.stringify({ tool_use_id: jqStr(payload.tool_use_id), started })}
`);
  } catch {}
  return ok();
}
async function recordBashChanges(io, payload) {
  try {
    const projectDir = io.projectDir || io.cwd;
    if (!await io.exists(join(projectDir, ".claude", "gate.yaml")))
      return [];
    const stateId = stateIdOf(payload);
    const startedFile = startedPath(projectDir, stateId);
    const raw = await io.readFile(startedFile);
    if (raw === undefined)
      return [];
    try {
      return await record(io, projectDir, stateId, raw, payload);
    } finally {
      await io.removeFiles([startedFile]);
    }
  } catch {
    return [];
  }
}
async function record(io, projectDir, stateId, raw, payload) {
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isDict(saved) || typeof saved.started !== "number")
    return [];
  if (jqStr(saved.tool_use_id) !== jqStr(payload.tool_use_id))
    return [];
  const command = jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined);
  if (SKIP_COMMAND_RE.test(command))
    return [];
  const cwd = jqStr(payload.cwd) || io.cwd;
  const top = await io.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 1e4 });
  if (top.exitCode !== 0)
    return [];
  const root = top.stdout.replace(/\n+$/, "");
  if (root === "")
    return [];
  const listed = await io.run(["git", "-C", cwd, "ls-files", "-z", "--modified", "--others", "--exclude-standard", "--full-name"], { timeoutMs: 1e4 });
  if (listed.exitCode !== 0)
    return [];
  const threshold = saved.started - MTIME_SLACK_MS;
  const stateDir = join(projectDir, ".claude", STATE_DIR);
  const picked = [];
  for (const rel of new Set(listed.stdout.split("\x00").filter((s) => s !== ""))) {
    const abs = join(root, rel);
    if (abs.startsWith(`${stateDir}/`) || rel.startsWith(`.claude/${STATE_DIR}/`))
      continue;
    const st = await io.stat(abs);
    if (st?.kind === "file" && st.mtimeMs >= threshold)
      picked.push(abs);
  }
  if (picked.length === 0)
    return [];
  const memo = join(stateDir, `changed_files.${stateId}.txt`);
  const existing = await io.readFile(memo) ?? "";
  const have = new Set(existing.split(`
`));
  const added = picked.filter((p) => !have.has(p));
  if (added.length > 0)
    await io.writeFile(memo, `${existing}${added.map((p) => `${p}
`).join("")}`);
  return added;
}
async function bashChanges(io, payload) {
  const recorded = await recordBashChanges(io, payload);
  if (recorded.length === 0)
    return ok();
  return stopTestGate(io, "rules", payload);
}

// src/correct.ts
var HOUR_MS = 3600000;
var DAY_MS2 = 86400000;
var DEFAULT_WINDOW_MS = 30 * DAY_MS2;
var DEFAULT_MIN = 2;
function parseCorrectArgs(args) {
  const out = { window: DEFAULT_WINDOW_MS, apply: false, min: DEFAULT_MIN };
  const tokens = args.split(/\s+/).filter((t) => t !== "");
  for (let i = 0;i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    if (key === "apply" && eq < 0) {
      out.apply = true;
    } else if (key === "--window" || key === "--min") {
      const inline = eq >= 0;
      const value = inline ? token.slice(eq + 1) : tokens[i + 1] ?? "";
      const parsed = key === "--window" ? parseWindow(value) : parseMin(value);
      if (parsed === undefined)
        continue;
      if (key === "--window")
        out.window = parsed;
      else
        out.min = parsed;
      if (!inline)
        i++;
    }
  }
  return out;
}
function parseWindow(v) {
  const m = /^(\d+)([dh])$/.exec(v);
  if (!m)
    return;
  const n = Number(m[1]);
  return n > 0 ? n * (m[2] === "d" ? DAY_MS2 : HOUR_MS) : undefined;
}
function parseMin(v) {
  if (!/^\d+$/.test(v))
    return;
  const n = Number(v);
  return n > 0 ? n : undefined;
}
function windowLabel(ms) {
  return ms % DAY_MS2 === 0 ? `${ms / DAY_MS2}d` : `${Math.round(ms / HOUR_MS)}h`;
}
async function readViolations(io) {
  const text = await io.readFile(violationsLogPath(io));
  if (text === undefined)
    return [];
  const entries = [];
  for (const line of text.split(`
`)) {
    if (line.trim() === "")
      continue;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
      continue;
    const d = data;
    if (typeof d.rule !== "string" || d.rule === "")
      continue;
    entries.push({
      ts: typeof d.ts === "string" ? d.ts : "",
      rule: d.rule,
      count: typeof d.count === "number" ? d.count : 0,
      severity: typeof d.severity === "string" ? d.severity : "",
      event: typeof d.event === "string" ? d.event : "",
      detail: typeof d.detail === "string" ? d.detail : ""
    });
  }
  return entries;
}
var bump = (rec, key) => {
  if (key !== "")
    rec[key] = (rec[key] ?? 0) + 1;
};
function aggregateViolations(entries, now, windowMs) {
  const stats = new Map;
  const details = new Map;
  const since = now - windowMs;
  for (const e of entries) {
    let s = stats.get(e.rule);
    if (!s) {
      s = { total: 0, inWindow: 0, bySeverity: {}, byEvent: {} };
      stats.set(e.rule, s);
    }
    s.total++;
    const t = Date.parse(e.ts);
    if (e.ts !== "" && (s.lastTs === undefined || t > Date.parse(s.lastTs)))
      s.lastTs = e.ts;
    if (Number.isNaN(t) || t < since)
      continue;
    s.inWindow++;
    bump(s.bySeverity, e.severity);
    bump(s.byEvent, e.event);
    if (e.detail !== "") {
      const d = details.get(e.rule) ?? new Map;
      d.set(e.detail, (d.get(e.detail) ?? 0) + 1);
      details.set(e.rule, d);
    }
  }
  for (const [rule, d] of details) {
    let top;
    let best = 0;
    for (const [detail, n] of d) {
      if (n > best) {
        best = n;
        top = detail;
      }
    }
    const s = stats.get(rule);
    if (s && top !== undefined)
      s.topDetail = top;
  }
  return stats;
}
var enforceTemplate = (lang) => tr(lang)(CORRECT_ENFORCE_TEMPLATE);
var oneLine2 = (s, max = 60) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
var countsText = (rec) => Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
function inactiveReason(rule, now, lang) {
  const t = tr(lang);
  if (rule.expires !== undefined && now > rule.expires)
    return t(CORRECT_EXPIRED, new Date(rule.expires).toISOString().slice(0, 10));
  const parts = [];
  if (rule.projects.length > 0)
    parts.push("projects");
  if (rule.whenExists.length > 0)
    parts.push("when_exists");
  return t(CORRECT_NOT_MATCHING, parts.join(" / ") || t(CORRECT_CONDITIONS));
}
function buildProposals(rules, inactive, stats, opts) {
  const bumps = [];
  const enforces = [];
  const stales = [];
  const expireds = [];
  const label = windowLabel(opts.window);
  const t = tr(opts.lang);
  for (const rule of rules) {
    const s = stats.get(rule.name);
    const n = s?.inWindow ?? 0;
    if (n >= opts.min && s) {
      const top = s.topDetail ? t(CORRECT_TOP_DETAIL, oneLine2(s.topDetail)) : "";
      if (rule.count < 3) {
        bumps.push({
          kind: "bump",
          rule: rule.name,
          path: rule.path,
          from: rule.count,
          to: 3,
          n,
          reason: t(CORRECT_BUMP_TO_CONFIRMED, label, n, countsText(s.bySeverity), top)
        });
      } else if (rule.count < 5) {
        const strong = (s.bySeverity.ask ?? 0) + (s.bySeverity.block ?? 0);
        if (strong >= opts.min) {
          bumps.push({
            kind: "bump",
            rule: rule.name,
            path: rule.path,
            from: rule.count,
            to: 5,
            n,
            reason: t(CORRECT_BUMP_TO_DENY, label, strong, countsText(s.bySeverity), top)
          });
        }
      }
    }
    if (rule.count >= 3 && rule.enforce.length === 0) {
      enforces.push({
        kind: "enforce",
        rule: rule.name,
        path: rule.path,
        reason: t(CORRECT_NO_ENFORCE, rule.count),
        template: enforceTemplate(opts.lang)
      });
    }
    if (rule.count >= 3 && rule.enforce.length > 0 && n === 0 && (s?.total ?? 0) === 0) {
      stales.push({
        kind: "stale",
        rule: rule.name,
        path: rule.path,
        reason: t(CORRECT_STALE)
      });
    }
  }
  for (const rule of inactive) {
    expireds.push({ kind: "expired", rule: rule.name, path: rule.path, reason: t(CORRECT_EXPIRED_ACTION, inactiveReason(rule, opts.now, opts.lang)) });
  }
  bumps.sort((a, b) => b.to - a.to || b.n - a.n);
  return [...bumps.map(({ n: _n, ...p }) => p), ...enforces, ...stales, ...expireds];
}
function formatReport(proposals, stats, opts, rulesCount, applied) {
  const t = tr(opts.lang);
  let violations = 0;
  for (const s of stats.values())
    violations += s.inWindow;
  const lines = [t(CORRECT_REPORT_HEADER, windowLabel(opts.window), rulesCount, violations)];
  if (proposals.length === 0) {
    lines.push(t(CORRECT_NO_PROPOSALS));
  } else {
    for (const p of proposals) {
      const head = p.kind === "bump" ? `${p.rule}: count ${p.from} → ${p.to}` : p.rule;
      lines.push(`- [${p.kind}] ${head}`, `    ${p.reason}`, `    ${p.path}`);
    }
  }
  if (opts.apply) {
    lines.push(t(!applied || applied.length === 0 ? CORRECT_APPLY_NONE : CORRECT_APPLY_DONE));
    for (const a of applied ?? [])
      lines.push(`  - ${a.path} (count ${a.from} → ${a.to})`);
  } else {
    lines.push(t(CORRECT_APPLY_HINT));
  }
  return lines.join(`
`);
}
async function applyCountBumps(io, proposals) {
  const applied = [];
  for (const p of proposals) {
    if (p.kind !== "bump")
      continue;
    const content = await io.readFile(p.path);
    if (content === undefined)
      continue;
    const fm = FRONTMATTER_RE.exec(content);
    if (!fm)
      continue;
    const head = fm[0];
    const re = /^count:[ \t]*(\d+)[ \t]*(?=\r?$)/m;
    const m = re.exec(head);
    if (!m || Number(m[1]) !== p.from)
      continue;
    const next = head.replace(re, `count: ${p.to}`);
    await io.writeFile(p.path, next + content.slice(head.length));
    applied.push({ path: p.path, from: p.from, to: p.to });
  }
  return applied;
}
function buildContext(proposals, applied, lang) {
  if (proposals.length === 0)
    return [];
  const t = tr(lang);
  const lines = [t(CORRECT_CONTEXT)];
  if (applied.length > 0)
    lines.push(t(CORRECT_CONTEXT_APPLIED, applied.map((a) => `${a.path} (${a.from} → ${a.to})`).join(", ")));
  return [lines.join(`
`)];
}
async function listInactive(io, active) {
  const dirs = [...new Set([feedbackDir(io), projectFeedbackDir(io)])];
  const activeNames = new Set(active.map((r) => r.name));
  const seen = new Set;
  const out = [];
  for (const dir of dirs) {
    for (const rule of await listRules(io, dir)) {
      if (seen.has(rule.path))
        continue;
      seen.add(rule.path);
      if (activeNames.has(rule.name))
        continue;
      if (!await isRuleActive(io, rule))
        out.push(rule);
    }
  }
  return out;
}
async function correctCommand(io, args) {
  try {
    const parsed = parseCorrectArgs(args);
    const now = await io.now();
    const rules = await listRules(io);
    const inactive = await listInactive(io, rules);
    const stats = aggregateViolations(await readViolations(io), now, parsed.window);
    const opts = { window: parsed.window, min: parsed.min, now, lang: io.lang };
    const proposals = buildProposals(rules, inactive, stats, opts);
    const applied = parsed.apply ? await applyCountBumps(io, proposals) : undefined;
    return {
      text: formatReport(proposals, stats, { window: parsed.window, apply: parsed.apply, lang: io.lang }, rules.length, applied),
      context: buildContext(proposals, applied ?? [], io.lang)
    };
  } catch (e) {
    return { text: `[correct] internal error: ${e instanceof Error ? e.message : String(e)}`, context: [] };
  }
}

// src/engine-io.ts
var errorText = (e) => e instanceof Error ? e.message : String(e);
async function readEnv($) {
  const [HOME, PATH, CLAUDE_FEEDBACK_DIR, DOGWOOD_BIN, TERM_PROGRAM, __CFBundleIdentifier, FEEDBACK_GATE_LANG, LC_ALL, LC_MESSAGES, LANG] = await Promise.all([
    $.env.get("HOME"),
    $.env.get("PATH"),
    $.env.get("CLAUDE_FEEDBACK_DIR"),
    $.env.get("DOGWOOD_BIN"),
    $.env.get("TERM_PROGRAM"),
    $.env.get("__CFBundleIdentifier"),
    $.env.get("FEEDBACK_GATE_LANG"),
    $.env.get("LC_ALL"),
    $.env.get("LC_MESSAGES"),
    $.env.get("LANG")
  ]);
  return { HOME, PATH, CLAUDE_FEEDBACK_DIR, DOGWOOD_BIN, TERM_PROGRAM, __CFBundleIdentifier, FEEDBACK_GATE_LANG, LC_ALL, LC_MESSAGES, LANG };
}
async function createIo($, options = {}) {
  const [env, projectDir, cwd] = await Promise.all([readEnv($), $.session.root(), $.session.cwd()]);
  const lang = resolveLang(env, options.language);
  const stat = async (path) => {
    try {
      const s = await $.fs.stat(path);
      return { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return;
    }
  };
  const run = async (argv, options = {}) => {
    try {
      const r = await $.process.run(argv, {
        ...options.cwd !== undefined ? { cwd: options.cwd } : {},
        ...options.env !== undefined ? { env: options.env } : {},
        ...options.stdin !== undefined ? { stdin: options.stdin } : {},
        ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false };
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false, error: errorText(e) };
    }
  };
  const existing = async (paths) => {
    const found = [];
    for (const p of paths)
      if (await $.fs.exists(p).catch(() => false))
        found.push(p);
    return found;
  };
  return {
    env,
    lang,
    projectDir,
    cwd,
    pluginRoot: $.plugin.root,
    readFile: (path) => $.fs.read(path).then(String, () => {
      return;
    }),
    writeFile: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path).catch(() => false),
    stat,
    list: async (path) => {
      try {
        return (await $.fs.list(path)).map((e) => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs }));
      } catch {
        return [];
      }
    },
    isExecutable: async (path) => (await stat(path))?.kind === "file",
    removeFiles: async (paths) => {
      const found = await existing(paths);
      if (found.length > 0)
        await run(["rm", "-f", "--", ...found]);
    },
    removeDir: async (path) => {
      if ((await stat(path))?.kind === "dir")
        await run(["rmdir", "--", path]);
    },
    removeTree: async (path) => {
      if (await $.fs.exists(path).catch(() => false))
        await run(["rm", "-rf", "--", path]);
    },
    run,
    now: () => $.clock.now(),
    progress: (text) => $.ui.status(text),
    result: (text) => $.ui.status(text),
    redraw: () => $.ui.invalidate("ui.render"),
    every: (ms, fn) => {
      const timer = $.clock.every(ms, fn);
      return () => timer.cancel();
    }
  };
}

// src/feedback-guard.ts
var SEVERITY_ORDER = { warn: 0, ask: 1, block: 2, deny: 3 };
var decisionFor = (severity) => severity === "deny" || severity === "block" ? "deny" : "ask";
var buildReason = (violations) => violations.map((v) => `${v.rule} (count: ${v.count}): ${v.message}`).join(`
`);
var askStatePath = (io, sessionId) => join(feedbackDir(io), ".ask_state", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
async function loadAskedKeys(io, sessionId) {
  try {
    const text = await io.readFile(askStatePath(io, sessionId));
    if (text === undefined)
      return new Set;
    const data = JSON.parse(text);
    if (isDict(data) && Array.isArray(data.asked))
      return new Set(data.asked.map(String));
  } catch {}
  return new Set;
}
async function saveAskedKeys(io, sessionId, askedKeys) {
  try {
    await io.writeFile(askStatePath(io, sessionId), JSON.stringify({ asked: [...askedKeys].sort() }));
  } catch {}
}
function askKey(v, toolInput) {
  const target = v.event === "pre_edit" ? truthy(toolInput.file_path) ? String(toolInput.file_path) : "" : "";
  return `${v.rule}|${v.event}|${target}`;
}
async function downgradeRepeatedAsks(io, violations, sessionId, toolInput) {
  if (!truthy(sessionId))
    return;
  const sid = String(sessionId);
  const asked = await loadAskedKeys(io, sid);
  const newlyAsked = new Set;
  for (const v of violations) {
    if (v.severity !== "ask")
      continue;
    const key = askKey(v, toolInput);
    if (asked.has(key))
      v.severity = "warn";
    else
      newlyAsked.add(key);
  }
  if (newlyAsked.size > 0)
    await saveAskedKeys(io, sid, new Set([...asked, ...newlyAsked]));
}
async function main2(io, payload) {
  const toolName = truthy(payload.tool_name) ? String(payload.tool_name) : "";
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {};
  const rules = await listRules(io);
  let violations;
  if (toolName === "Bash") {
    violations = await evalPreBash(io, rules, truthy(toolInput.command) ? String(toolInput.command) : "");
  } else if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const filePath = truthy(toolInput.file_path) ? String(toolInput.file_path) : "";
    if (!filePath)
      return ok();
    violations = await evalPreEdit(io, rules, filePath, extractPreEditContent(toolName, toolInput));
  } else {
    return ok();
  }
  if (violations.length === 0)
    return ok();
  await downgradeRepeatedAsks(io, violations, payload.session_id, toolInput);
  for (const v of violations)
    await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail);
  const blocking = violations.filter((v) => v.severity !== "warn");
  const warnings = violations.filter((v) => v.severity === "warn");
  let stdout = "";
  if (blocking.length > 0) {
    const top = blocking.reduce((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a);
    stdout = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decisionFor(top.severity),
        permissionDecisionReason: buildReason(blocking)
      }
    })}
`;
  }
  const stderr = warnings.map((v) => `[feedback-guard] warn: ${v.rule} (count: ${v.count}): ${v.message}
`).join("");
  return ok(stdout, stderr);
}
async function feedbackGuard(io, payload) {
  try {
    return await main2(io, payload);
  } catch (e) {
    return ok("", `[feedback-guard] internal error (ignored): ${e instanceof Error ? e.message : String(e)}
`);
  }
}

// src/feedback-inject.ts
async function formatFull(io, rule) {
  const lines = [tr(io.lang)(INJECT_RULE_TITLE, rule.name, rule.count), rule.description];
  const intro = await loadBodyIntro(io, rule.path);
  if (intro)
    lines.push(intro);
  return lines.join(`
`);
}
var byCountThenName = (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
async function buildOutput(io, rules) {
  const blocks = [];
  for (const r of [...rules].sort(byCountThenName))
    blocks.push(await formatFull(io, r));
  return tr(io.lang)(INJECT_HEADER) + blocks.join(`

`);
}
async function feedbackInject(io) {
  try {
    const rules = (await listRules(io)).filter((r) => r.count >= 3);
    if (rules.length === 0)
      return ok();
    return ok(await buildOutput(io, rules));
  } catch (e) {
    return ok("", `[feedback-inject] internal error (ignored): ${e instanceof Error ? e.message : String(e)}
`);
  }
}

// src/feedback-post-edit.ts
async function main3(io, payload) {
  const toolName = truthy(payload.tool_name) ? String(payload.tool_name) : "";
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit")
    return ok();
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {};
  const filePath = truthy(toolInput.file_path) ? String(toolInput.file_path) : "";
  if (!filePath)
    return ok();
  const rules = await listRules(io);
  const violations = await evalPostEdit(io, rules, filePath);
  if (violations.length === 0)
    return ok();
  for (const v of violations)
    await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail);
  const warnings = violations.filter((v) => v.severity === "warn");
  const blocking = violations.filter((v) => v.severity !== "warn");
  let stderr = warnings.map((v) => `[feedback-post-edit] warn: ${v.rule} (count: ${v.count}): ${v.message}
`).join("");
  if (blocking.length === 0)
    return ok("", stderr);
  const lines = blocking.map((v) => `[feedback-post-edit] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`);
  stderr += lines.map((l) => `${l}
`).join("");
  const stdout = `${JSON.stringify({ decision: "block", reason: lines.join(`
`) })}
`;
  return ok(stdout, stderr);
}
async function feedbackPostEdit(io, payload) {
  try {
    return await main3(io, payload);
  } catch (e) {
    return ok("", `[feedback-post-edit] internal error (ignored): ${e instanceof Error ? e.message : String(e)}
`);
  }
}

// src/outcome.ts
var TEXT_CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);
var parseJson = (text) => {
  const t = text.trim();
  if (!t.startsWith("{"))
    return;
  try {
    const v = JSON.parse(t);
    return isDict(v) ? v : undefined;
  } catch {
    return;
  }
};
var fromJson = (event, json) => {
  const out = {};
  if (json.decision === "block")
    out.block = String(json.reason ?? "");
  if (json.continue === false) {
    out.preventContinuation = true;
    if (typeof json.stopReason === "string")
      out.stopReason = json.stopReason;
  }
  const specific = json.hookSpecificOutput;
  if (isDict(specific)) {
    if (typeof specific.additionalContext === "string" && specific.additionalContext !== "") {
      out.additionalContext = [specific.additionalContext];
    }
    if (event === "PreToolUse") {
      const reason = String(specific.permissionDecisionReason ?? "");
      if (specific.permissionDecision === "allow")
        out.allow = true;
      else if (specific.permissionDecision === "ask")
        out.ask = reason;
      else if (specific.permissionDecision === "deny")
        out.deny = reason;
    }
  }
  return out;
};
var toOutcome = (event, ran) => {
  if (ran.exitCode === 2) {
    const reason = ran.stderr.trim() || "hook exited with code 2";
    return event === "PreToolUse" ? { deny: reason } : { block: reason };
  }
  if (ran.exitCode !== 0)
    return {};
  const json = parseJson(ran.stdout);
  if (json)
    return fromJson(event, json);
  const text = ran.stdout.trim();
  return text !== "" && TEXT_CONTEXT_EVENTS.has(event) ? { additionalContext: [text] } : {};
};
var merge2 = (first, second) => {
  const out = { ...second, ...first };
  const ctx = [...first.additionalContext ?? [], ...second.additionalContext ?? []];
  if (ctx.length > 0)
    out.additionalContext = ctx;
  else
    delete out.additionalContext;
  return out;
};
var decided = (o) => o.block !== undefined || o.deny !== undefined || o.ask !== undefined || o.allow === true;

// src/record-changes.ts
async function recordChanges(io, payload) {
  const projectDir = io.projectDir || io.cwd;
  if (!await io.exists(join(projectDir, ".claude", "gate.yaml")))
    return ok();
  const filePath = jqStr(isDict(payload.tool_input) ? payload.tool_input.file_path : undefined);
  const sessionId = jqStr(payload.session_id) || "unknown";
  const agentId = jqStr(payload.agent_id);
  const stateId = agentId ? `${sessionId}--${agentId}` : sessionId;
  const memo = join(projectDir, ".claude", ".gate-status", `changed_files.${stateId}.txt`);
  if (filePath) {
    const existing = await io.readFile(memo) ?? "";
    if (!existing.split(`
`).includes(filePath))
      await io.writeFile(memo, `${existing}${filePath}
`);
  }
  return ok();
}

// src/reset-gate.ts
var STATE_FILES = [
  ["changed_files", ".txt"],
  ["gate_attempts", ".txt"],
  ["gate_passed", ".txt"],
  ["gate_push_verified", ".txt"],
  ["gate_reported", ".txt"],
  ["gate_pending_checks", ".json"],
  ["gate_trace", ".jsonl"],
  ["gate_deferred", ".json"],
  ["bash_started", ".json"],
  ["feedback_gate_attempts", ".txt"],
  ["summary", ".txt"]
];
var DAY_MS3 = 1440 * 60 * 1000;
var globMatch = (name, prefix, suffix) => name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix);
async function resetGate(io, payload) {
  const projectDir = io.projectDir || io.cwd;
  const claudeDir = join(projectDir, ".claude");
  const stateDir = join(claudeDir, ".gate-status");
  const sessionId = jqStr(payload.session_id) || "unknown";
  const source = jqStr(payload.source);
  const now = await io.now();
  if (source === "startup" || source === "clear") {
    for (const dir of [stateDir, claudeDir]) {
      const names = (await io.list(dir)).map((e) => e.name);
      const doomed = [];
      for (const [base, ext] of STATE_FILES) {
        const exact = `${base}.${sessionId}${ext}`;
        for (const name of names) {
          if (name === exact || globMatch(name, `${base}.${sessionId}--`, ext))
            doomed.push(join(dir, name));
        }
      }
      await io.removeFiles(doomed);
    }
    for (const logRoot of [join(stateDir, "logs"), join(claudeDir, "hooks", "logs")]) {
      for (const e of await io.list(logRoot)) {
        if (e.name === sessionId || e.name.startsWith(`${sessionId}--`))
          await io.removeTree(join(logRoot, e.name));
      }
    }
  }
  for (const dir of [stateDir, claudeDir]) {
    const old = [];
    for (const e of await io.list(dir)) {
      if (e.kind !== "file" || e.mtimeMs >= now - DAY_MS3)
        continue;
      if (STATE_FILES.some(([base, ext]) => globMatch(e.name, `${base}.`, ext))) {
        old.push(join(dir, e.name));
      }
    }
    await io.removeFiles(old);
  }
  for (const logRoot of [join(stateDir, "logs"), join(claudeDir, "hooks", "logs")]) {
    for (const e of await io.list(logRoot)) {
      if (e.kind !== "dir")
        continue;
      const st = await io.stat(join(logRoot, e.name));
      if (st && st.mtimeMs < now - DAY_MS3)
        await io.removeTree(join(logRoot, e.name));
    }
  }
  await io.removeDir(join(claudeDir, "hooks", "logs"));
  await io.removeDir(join(claudeDir, "hooks"));
  return ok();
}

// src/rules-file.ts
var DEFAULT_RULES_FILE = "~/.claude/feedback-gate/feedback_rules.md";
var bundledRulesName = (lang) => lang === "en" ? "feedback_rules.en.md" : "feedback_rules.md";
async function loadRules(io, rulesFile) {
  const home = io.env.HOME;
  const configured = typeof rulesFile === "string" && rulesFile !== "" ? rulesFile : DEFAULT_RULES_FILE;
  const custom = configured.startsWith("~") ? home ? `${home}${configured.slice(1)}` : undefined : configured;
  const bundled = join(io.pluginRoot, "rules", bundledRulesName(io.lang));
  for (const path of [custom, bundled]) {
    if (path && await io.exists(path))
      return (await io.readFile(path) ?? "").trim();
  }
  return "";
}

// src/register.ts
var PROGRESS_DELAY_MS = 3000;
var str = (v) => typeof v === "string" ? v : "";
async function runSteps($, options, event, steps) {
  let acc = {};
  const base = await createIo($, options);
  const sessionId = await $.session.id();
  let shown = false;
  let pending;
  let cancelDelay;
  const show = () => {
    if (shown || pending === undefined)
      return;
    shown = true;
    cancelDelay?.();
    base.progress?.(pending);
  };
  const io = {
    ...base,
    progress: (text) => {
      if (shown)
        return base.progress?.(text);
      pending = text;
      if (text === undefined || cancelDelay)
        return;
      if (!base.every)
        return show();
      cancelDelay = base.every(PROGRESS_DELAY_MS, show);
      if (shown)
        cancelDelay();
    }
  };
  try {
    for (const step of steps) {
      const ran = await step(io).catch(() => {
        return;
      });
      if (ran)
        acc = merge2(acc, toOutcome(event, ran));
    }
  } finally {
    cancelDelay?.();
    if (shown)
      base.progress?.(await loadSummary(base, sessionId));
  }
  return acc;
}
async function withNext(next, e, mine) {
  const rest = await next(e);
  return merge2(mine, rest);
}
export const register = (on, options) => {
  on("session.start", async ($, e, next) => {
    try {
      const io = await createIo($, options);
      await $.command.register({
        name: "correct",
        description: tr(io.lang)(CORRECT_DESCRIPTION),
        argumentHint: "[--window 30d] [--min 2] [apply]"
      });
    } catch {}
    return next(e);
  });
  on("command.run", { command: "correct" }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? "")));
  on("classic.SessionStart", async ($, e, next) => {
    const mine = await runSteps($, options, "SessionStart", [(io) => resetGate(io, e)]);
    return withNext(next, e, mine);
  });
  on("classic.UserPromptSubmit", async ($, e, next) => {
    const mine = {};
    const text = await createIo($, options).then((io) => loadRules(io, options.rulesFile));
    if (text !== "")
      mine.additionalContext = [text];
    const inject = await runSteps($, options, "UserPromptSubmit", [(io) => feedbackInject(io)]);
    return withNext(next, e, merge2(mine, inject));
  });
  on("classic.PreToolUse", async ($, e, next) => {
    const tool = str(e.tool);
    const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool);
    if (!guardsAgents && !/^(Bash|Edit|Write|MultiEdit)$/.test(tool))
      return next(e);
    const { tool: _tool, tool_use_id, agentId, ...toolInput } = e;
    const payload = {
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id
    };
    if (typeof agentId === "string" && agentId !== "")
      payload.agent_id = agentId;
    const step = guardsAgents ? async (io) => agentLaunchGuard(payload, io.lang) : (io) => feedbackGuard(io, payload);
    const steps = tool === "Bash" ? [(io) => bashStarted(io, payload), step] : [step];
    const mine = await runSteps($, options, "PreToolUse", steps);
    if (decided(mine))
      return mine;
    return withNext(next, e, mine);
  });
  on("classic.PostToolUse", async ($, e, next) => {
    if (str(e.tool_name) === "Bash") {
      const mine = await runSteps($, options, "PostToolUse", [(io) => bashChanges(io, e)]);
      return withNext(next, e, mine);
    }
    if (!/^(Write|Edit|MultiEdit)$/.test(str(e.tool_name)))
      return next(e);
    const mine = await runSteps($, options, "PostToolUse", [
      (io) => recordChanges(io, e),
      (io) => feedbackPostEdit(io, e),
      (io) => stopTestGate(io, "rules", e)
    ]);
    return withNext(next, e, mine);
  });
  on("classic.Notification", async ($, e, next) => {
    await runSteps($, options, "Notification", [(io) => notification(io, "notify", e)]);
    return next(e);
  });
  on("classic.Stop", async ($, e, next) => {
    const mine = await runSteps($, options, "Stop", [(io) => allStop(io, e)]);
    return withNext(next, e, mine);
  });
  on("classic.SubagentStop", async ($, e, next) => {
    const mine = await runSteps($, options, "SubagentStop", [(io) => stopTestGate(io, "checks", e), (io) => feedbackStopCheck(io, e)]);
    return withNext(next, e, mine);
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey)
      return next(e);
    const io = await createIo($, options);
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e);
  });
};
