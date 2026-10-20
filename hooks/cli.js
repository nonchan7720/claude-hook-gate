// src/i18n.ts
import i18next from "./vendor/i18next.js";
import { parse } from "./vendor/yaml.js";

// locales/en.yaml
var en_default = `# Messages printed by the hooks (English). Has the same keys as ja.yaml (tests/i18n.spec.ts checks the key sets match).
# {{name}} is i18next interpolation.
notify:
  waiting: "Waiting for you"
  waitingFallback: "Claude is waiting for your input"
  done: "Done"
  doneFallback: "The response has finished"

inject:
  header: "# Confirmed feedback rules (count >= 3)\\nThese rules were pointed out repeatedly and are confirmed. A hook blocks violations.\\n\\n"
  ruleTitle: "■ {{name}} (pointed out {{count}} times so far)"
  brokenRules: "# Unreadable feedback rules\\nThe following rule files could not be read and are disabled (where only an enforce entry is invalid, only that entry is disabled). Their enforcement does not work until they are fixed. Tell the user:"

rules:
  unreadable: "cannot read the file: {{error}}"
  enforceNotList: "enforce is not a list ({{type}}). Write each entry as \`- event: ...\`"
  enforceItemNotMapping: "enforce[{{index}}] is not a mapping ({{type}})"
  badRegex: "enforce[{{index}}].{{key}} is not a usable regular expression: {{error}}"
  evalError: "enforce[{{index}}] failed to evaluate: {{error}}"

guard:
  evaluating: "[feedback-guard] evaluating: {{rule}}"

postEdit:
  checking: "[feedback-post-edit] checking: {{rule}} ({{file}})"

bashEdit:
  header: "[feedback] Files rewritten by Bash violate feedback rules (the same checks as Edit / Write)."
  preEditAfter: "Note: this is a pre_edit rule, but with Bash the content cannot be known before it runs, so it was detected after the command (the file is already written; fix it to follow the rule)."

stopCheck:
  checking: "[feedback-stop-check] checking: {{rule}} ({{file}})"
  gaveUp: "[feedback-stop-check] Blocked {{max}} times in a row. Giving up the loop; please check manually."
  fixAbove: "[feedback-stop-check] Fix the above (attempt {{attempt}}/{{max}})."

subagentReport:
  header: "[feedback-gate] Results of the hooks run when subagent {{agent}} stopped (gate checks and feedback stop_check). Use these instead of reading the gate logs or re-running the checks:"

autoCount:
  bumped: "[feedback-gate] Violation detected: raised the count of {{rule}} from {{from}} to {{to}} ({{path}}). Repeating the same violation escalates enforcement (warn → ask/block → deny)."

launch:
  checklist: "--- Check: what to do / background / current state of the code / what not to do / done criteria"
  promptTo: "Prompt to send to {{agentType}}:"
  messageTo: "Message to send to {{recipient}}:"
  unknownRecipient: "unknown recipient"

correct:
  description: "Aggregate the feedback rules and the violation log, and propose count bumps and enforce additions"
  enforceTemplate: |-
    enforce:
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
        message: 'instruction shown on violation'
  expired: "expires ({{date}}) has passed"
  conditions: "the conditions"
  notMatching: "{{what}} do not match this project, so the rule is inactive"
  topDetail: ". Most frequent: {{detail}}"
  bumpToConfirmed: "{{n}} violations in the last {{window}} ({{counts}}). Promote to a confirmed rule{{top}}"
  bumpToDeny: "ask / block {{strong}} times in the last {{window}} ({{counts}}). Raise to deny{{top}}"
  noEnforce: "Confirmed rule with count {{count}} but no enforce, so no hook can detect it (and it never appears in the violation log)"
  stale: "Has enforce but has never appeared in the violation log. Check that the enforce works and that the rule is not out of date"
  expiredAction: "{{reason}}. Consider deleting or updating it"
  broken: "unreadable and disabled: {{reason}}. Fix the file"
  reportHeader: "[correct] last {{window}}: {{rules}} rules / {{violations}} violations"
  noProposals: "No proposals."
  applyNone: "apply: no files were rewritten."
  applyDone: "apply: count was rewritten."
  applyHint: "\`/correct apply\` writes the count bumps of the bump proposals to the files (enforce is proposal only)."
  context: |-
    This is the result of /correct. Present the proposals above to the user.
    - For an enforce addition, derive a regex / glob from the body of the rule and propose a concrete entry (template: the enforce section of rules/feedback_rules.md).
    - Always ask the user before rewriting any file (as the rules in rules/feedback_rules.md say).
    - For stale / expired, ask the user whether to keep, update or delete the rule.
    - For broken, explain why the file cannot be read (YAML syntax, regex syntax and so on) and propose a fix (rewrite Python-only regex syntax into a form JavaScript accepts).
  contextApplied: "- apply has already rewritten count in the following files. Tell the user so: {{list}}"

band:
  running: "[gate] running:"
  waiting: "waiting"
  done: "[gate] done: {{counts}} ({{seconds}}s)"

dogwood:
  notFound: "dogwood binary not found (check DOGWOOD_BIN / PATH / ~/.cargo/bin)"
  runFailed: "failed to run dogwood: {{error}}"
  exited: "dogwood replay exited abnormally (exit {{code}}): {{detail}}"
  badJson: "could not parse the output of dogwood replay as JSON"
  noVerdict: "dogwood replay returned no verdict"
  badVerdict: "could not interpret the verdict of dogwood replay: {{verdict}}"

gate:
  headOmitted: "… (first {{n}} lines omitted)"
  restOmitted: "… (rest omitted)"
  failuresOmitted: "… ({{n}} more failures omitted; see the [gate] log path of each)"
  policyNotFound: "=== [gate] The policy file was not found: {{policy}}. Running without policy evaluation. ==="
  sharedResult: "[gate] The same run was in progress in another agent, so its result was taken over (log of the running side: {{logpath}})"
  timeout: "[gate] Killed after the timeout ({{seconds}}s). The command may be in an infinite loop or hung."
  failedOutputHeader: "--- output of the failed commands ---"
  nestedParallel: "=== [gate] ({{label}}) parallel cannot be nested inside parallel. Treated as a failure. ==="
  deferredNoCwd: "=== [gate] ({{label}}) cwd does not exist: {{cwd}}. Dropping this deferred entry. ==="
  cannotReadYaml: "cannot read gate.yaml: {{path}}"
  andMore: " and {{n}} more"
  skipUnmatched: "[gate] skip: {{files}} (matches no rule)"
  badPerFileDir: "=== [gate] Invalid per_file_dir value: {{value}} (use true / \\"file\\" / \\"pattern_root\\"). Skipping this rule. ==="
  skipBadPerFileDir: "[skip: invalid per_file_dir]"
  rootNoCwd: "=== [gate] ({{label}}) cwd does not exist: {{cwd}}. Skipping this root. ==="
  ruleNoCwd: "=== [gate] ({{label}}) cwd does not exist: {{cwd}}. Skipping this rule. ==="
  checkNoCwd: "=== [gate] (check:{{name}}) cwd does not exist: {{cwd}}. Skipping this check. ==="
  skipNoCwd: "[skip: no cwd]"
  noteNoCwd: "(cwd does not exist)"
  worktreeNotFound: "=== [gate] worktree not found: {{root}}. Excluding it. ==="
  rulesFailed: "[gate] Verification failed. Stopping (and reporting the work as done) is blocked until it is fixed. See the errors above and fix them now."
  rulesPassed: "[gate] rules phase passed:\\n{{body}}"
  checkNotFound: "=== [gate] \\"{{name}}\\" was not found in consistency_checks. Skipping. ==="
  checkNotFoundSummary: "(check:{{name}}) not found, skipped"
  skipCheckUndefined: "[gate] skip: check:{{name}} (not defined in consistency_checks)"
  nothingToRun: "(nothing to run)"
  allPassed: "[gate] All checks passed: {{labels}}. Report this result to the user and finish."
  passedReport: "[gate] All checks passed: {{labels}}"
  deferredTitle: "deferred verification commands"
  checksPassed: "[gate] {{title}} passed:\\n{{body}}"
  checksGaveUpStderr: "consistency checks failed {{max}} times in a row. Giving up the loop; please check manually."
  checksGaveUp: "[gate] Gave up because consistency checks failed {{max}} times in a row. The target files were returned to CHANGED unverified. Please check them manually. To clear this now, start a new session or run /clear (reset-gate on SessionStart removes the state files)."
  checksFailed: "[gate] Verification failed (attempt {{attempt}}/{{max}}). See the errors above and keep fixing."
  ymlTypo: "[gate] .claude/gate.yaml was not found but .claude/gate.yml exists. Check whether the extension is yml instead of yaml."
  policyUnevaluated: "=== [gate] ({{label}}) Skipped this time because the policy could not be evaluated (intentional throttling; no need to investigate. Queued, so it runs automatically later) [{{reason}}] $ {{cmd}} ==="
  policySkipped: "=== [gate] ({{label}}) Skipped this time by policy (intentional throttling; no need to investigate. Queued, so it runs automatically later) $ {{cmd}} ==="
  notePolicySkipped: "(deferred by the policy verdict; queued to run automatically later)"
  notePolicyUnevaluated: "(deferred because the policy could not be evaluated; queued to run automatically later: {{reason}})"
  internalError: "[gate] An internal error occurred, so the checks were skipped (work continues). See stderr for details."
`;

// locales/ja.yaml
var ja_default = `# hook が出すメッセージ（日本語）。en.yaml と同じキーを持つ（tests/i18n.spec.ts がキーの一致を検査する）。
# {{name}} は i18next の補間。
notify:
  waiting: "確認待ち"
  waitingFallback: "確認を待っています"
  done: "完了"
  doneFallback: "応答が完了しました"

inject:
  header: "# 確定フィードバックルール（count >= 3）\\nこれらは繰り返し指摘された確定ルール。違反すると hook がブロックする。\\n\\n"
  ruleTitle: "■ {{name}} (これまで {{count}} 回指摘されています)"
  brokenRules: "# 読めない feedback ルール\\n次のルールファイルが読めず無効になっています（enforce の要素だけが不正なものは、その要素だけが無効）。直すまで、その強制は効きません。ユーザーに伝えてください:"

rules:
  unreadable: "ファイルを読めません: {{error}}"
  enforceNotList: "enforce がリストではありません（{{type}}）。各要素を \`- event: ...\` の形で書いてください"
  enforceItemNotMapping: "enforce[{{index}}] が辞書ではありません（{{type}}）"
  badRegex: "enforce[{{index}}].{{key}} の正規表現が使えません: {{error}}"
  evalError: "enforce[{{index}}] の評価に失敗しました: {{error}}"

guard:
  evaluating: "[feedback-guard] 評価中: {{rule}}"

postEdit:
  checking: "[feedback-post-edit] 検査中: {{rule}} ({{file}})"

bashEdit:
  header: "[feedback] Bash が書き換えたファイルが feedback ルールに違反しています（Edit / Write と同じ検査）。"
  preEditAfter: "※ pre_edit のルールですが、Bash では書かれる内容が事前に分からないため、実行後に検知しました（書き込みは済んでいます。ルールに沿って直してください）。"

stopCheck:
  checking: "[feedback-stop-check] 検査中: {{rule}} ({{file}})"
  gaveUp: "[feedback-stop-check] {{max}} 回連続でブロックしました。ループを打ち切ります。手動確認を。"
  fixAbove: "[feedback-stop-check] 上記を修正してください（試行 {{attempt}}/{{max}}）。"

subagentReport:
  header: "[feedback-gate] サブエージェント {{agent}} の停止時に実行された hook（gate の検証と feedback の stop_check）の結果です。gate のログを読んだり検証を再実行したりせず、これを使ってください:"

autoCount:
  bumped: "[feedback-gate] 違反を検出したため {{rule}} の count を {{from}} → {{to}} に上げました（{{path}}）。同じ違反を繰り返すと強制力（warn → ask/block → deny）が上がります。"

launch:
  checklist: "--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件"
  promptTo: "{{agentType}} に送るプロンプト:"
  messageTo: "{{recipient}} に送るメッセージ:"
  unknownRecipient: "宛先不明"

correct:
  description: "feedback ルールと違反ログを集計し、count の引き上げや enforce の追加を提案する"
  enforceTemplate: |-
    enforce:
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
        message: '違反時に出す指示文'
  expired: "expires（{{date}}）を過ぎている"
  conditions: "条件"
  notMatching: "{{what}} がこのプロジェクトに一致せず無効"
  topDetail: "。最多: {{detail}}"
  bumpToConfirmed: "直近 {{window}} で {{n}} 回違反（{{counts}}）。確定ルールへ昇格{{top}}"
  bumpToDeny: "直近 {{window}} で ask / block が {{strong}} 回（{{counts}}）。deny へ引き上げ{{top}}"
  noEnforce: "count {{count}} の確定ルールだが enforce が無く、hook が検知できない（違反ログにも出ない）"
  stale: "enforce ありで違反ログに一度も出ていない。enforce が効いているか、ルールが古くなっていないか確認"
  expiredAction: "{{reason}}。削除または更新を検討"
  broken: "読めず無効になっている: {{reason}}。ファイルを直す"
  reportHeader: "[correct] 直近 {{window}}: ルール {{rules}} 件 / 違反 {{violations}} 件"
  noProposals: "提案はありません。"
  applyNone: "apply: 書き換えたファイルはありません。"
  applyDone: "apply: count を書き換えました。"
  applyHint: "\`/correct apply\` で bump の count 引き上げをファイルに書き込みます（enforce は提案のみ）。"
  context: |-
    /correct の結果です。ユーザーに上記の提案を提示してください。
    - enforce の追加は、対象ルールの本文から正規表現 / glob を起こして具体案を提案する（雛形は rules/feedback_rules.md の enforce 節）。
    - ファイルを書き換える前に、必ずユーザーに確認する（rules/feedback_rules.md のルールどおり）。
    - stale / expired は、ルールを残すか更新・削除するかをユーザーに尋ねる。
    - broken は、読めない理由（YAML の書き方・正規表現の書き方など）を説明し、直し方を提案する（Python 専用の正規表現の書き方は JavaScript で使える形に書き換える）。
  contextApplied: "- apply により次のファイルの count をすでに書き換えた。その事実をユーザーに伝えること: {{list}}"

band:
  running: "[gate] 実行中:"
  waiting: "待機中"
  done: "[gate] 完了: {{counts}} ({{seconds}}s)"

dogwood:
  notFound: "dogwood バイナリが見つかりません（DOGWOOD_BIN / PATH / ~/.cargo/bin を確認してください）"
  runFailed: "dogwood の実行に失敗しました: {{error}}"
  exited: "dogwood replay が異常終了しました（exit {{code}}）: {{detail}}"
  badJson: "dogwood replay の出力を JSON として読めませんでした"
  noVerdict: "dogwood replay が verdict を返しませんでした"
  badVerdict: "dogwood replay の verdict を解釈できませんでした: {{verdict}}"

gate:
  headOmitted: "…（先頭 {{n}} 行省略）"
  restOmitted: "…（以降省略）"
  failuresOmitted: "…（残り {{n}} 件の失敗は省略。各 [gate] log のパスを見てください）"
  policyNotFound: "=== [gate] policy に指定されたファイルが見つかりません: {{policy}}。ポリシー判定を行わず実行します。 ==="
  sharedResult: "[gate] 同じ実行が他のエージェントで走っていたため、その結果を受け取りました（実行側のログ: {{logpath}}）"
  timeout: "[gate] タイムアウト（{{seconds}}秒）で強制終了しました。無限ループやハングの可能性があります。"
  failedOutputHeader: "--- 失敗したコマンドの出力 ---"
  nestedParallel: "=== [gate] ({{label}}) parallel の中に parallel はネストできません。失敗扱いにします。 ==="
  deferredNoCwd: "=== [gate] ({{label}}) cwd が存在しません: {{cwd}}。この控えを破棄します。 ==="
  cannotReadYaml: "gate.yaml を読めません: {{path}}"
  andMore: " ほか{{n}}件"
  skipUnmatched: "[gate] skip: {{files}} (どのルールにもマッチしません)"
  badPerFileDir: "=== [gate] per_file_dir の値が不正です: {{value}}（true / \\"file\\" / \\"pattern_root\\" のいずれかを指定してください）。このルールをスキップします。 ==="
  skipBadPerFileDir: "[skip: per_file_dir不正]"
  rootNoCwd: "=== [gate] ({{label}}) cwd が存在しません: {{cwd}}。このルートをスキップします。 ==="
  ruleNoCwd: "=== [gate] ({{label}}) cwd が存在しません: {{cwd}}。このルールをスキップします。 ==="
  checkNoCwd: "=== [gate] (check:{{name}}) cwd が存在しません: {{cwd}}。このチェックをスキップします。 ==="
  skipNoCwd: "[skip: cwd無し]"
  noteNoCwd: "(cwd が存在しません)"
  worktreeNotFound: "=== [gate] worktree が見つかりません: {{root}}。対象から外します。 ==="
  rulesFailed: "[gate] 検証に失敗しました。直すまで終了（Stop）はブロックされ、完了報告もできません。上のエラーを見て、今ここで修正してください。"
  rulesPassed: "[gate] rules フェーズ成功:\\n{{body}}"
  checkNotFound: "=== [gate] consistency_checks に \\"{{name}}\\" が見つかりません。スキップします。 ==="
  checkNotFoundSummary: "(check:{{name}}) 見つかりません、スキップ"
  skipCheckUndefined: "[gate] skip: check:{{name}} (consistency_checks に定義がありません)"
  nothingToRun: "（対象なし）"
  allPassed: "[gate] 検証がすべて通りました: {{labels}}。この結果をユーザーに報告して終了してください。"
  passedReport: "[gate] 検証がすべて通りました: {{labels}}"
  deferredTitle: "後回しにした検証コマンド"
  checksPassed: "[gate] {{title}} 成功:\\n{{body}}"
  checksGaveUpStderr: "consistency checks が {{max}} 回連続失敗。ループを打ち切ります。手動確認を。"
  checksGaveUp: "[gate] consistency checks が{{max}}回連続で失敗したため打ち切りました。対象ファイルは未検証のまま CHANGED へ戻しました。手動で確認してください。今すぐ解除したい場合は新しいセッションを開始するか /clear を実行してください（SessionStart の reset-gate が状態ファイルを削除します）。"
  checksFailed: "[gate] 検証に失敗しました（試行 {{attempt}}/{{max}}）。上のエラーを見て修正を継続してください。"
  ymlTypo: "[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。拡張子が yaml ではなく yml になっていないか確認してください。"
  policyUnevaluated: "=== [gate] ({{label}}) ポリシーを評価できないため今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）［{{reason}}］ $ {{cmd}} ==="
  policySkipped: "=== [gate] ({{label}}) ポリシーにより今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます） $ {{cmd}} ==="
  notePolicySkipped: "(ポリシー判定で見送り。控えに積んだので後で自動実行)"
  notePolicyUnevaluated: "(ポリシーを評価できず見送り。控えに積んだので後で自動実行: {{reason}})"
  internalError: "[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。"
`;

// src/i18n.ts
var LANGS = ["ja", "en"];
var resources = {
  ja: parse(ja_default),
  en: parse(en_default)
};
var i18n = i18next.createInstance();
i18n.init({
  resources: { ja: { translation: resources.ja }, en: { translation: resources.en } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: LANGS,
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false
});
var tr = (lang) => i18n.getFixedT(lang);
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
    const pyFlags = m[1] ?? "";
    if (pyFlags.includes("x"))
      throw new Error(`unsupported Python inline flag (?x): ${source}`);
    for (const c of pyFlags)
      if ("ims".includes(c) && !fl.includes(c))
        fl += c;
  }
  src = replaceAnchors(src).replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>");
  return new RegExp(src, fl);
}
function replaceAnchors(src) {
  let out = "";
  let inClass = false;
  for (let i = 0;i < src.length; i++) {
    const c = src.charAt(i);
    if (c === "\\") {
      const next = src.charAt(i + 1);
      if (!inClass && next === "A")
        out += "(?<![\\s\\S])";
      else if (!inClass && (next === "Z" || next === "z"))
        out += "(?![\\s\\S])";
      else
        out += c + next;
      i++;
      continue;
    }
    if (c === "[" && !inClass) {
      inClass = true;
      out += c;
      if (src.charAt(i + 1) === "^")
        out += src.charAt(++i);
      if (src.charAt(i + 1) === "]") {
        i++;
        out += "\\]";
      }
      continue;
    }
    if (c === "]" && inClass)
      inClass = false;
    out += c;
  }
  return out;
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
      return ask(`${t("launch.promptTo", { agentType })}

${jqStr(input.prompt)}

${t("launch.checklist")}`);
    }
  } else if (tool === "SendMessage") {
    const recipient = jqStr(input.to);
    if (!ALLOW_RECIPIENTS.includes(recipient)) {
      return ask(`${t("launch.messageTo", { recipient: recipient || t("launch.unknownRecipient") })}

${jqStr(input.message)}

${t("launch.checklist")}`);
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

// src/load-yaml.ts
import { parse as parse2 } from "./vendor/yaml.js";
var PY_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
var PY_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/;
var pyBool = (original) => ({
  ...original,
  test: /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON|no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  resolve: (str) => PY_TRUE.test(str) ? true : PY_FALSE.test(str) ? false : str
});
var parseYaml = (text) => parse2(text, {
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
var errorsLogPath = (io) => join(feedbackDir(io), ".errors.jsonl");
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
var typeName = (v) => v === null || v === undefined ? "null" : Array.isArray(v) ? "list" : isDict(v) ? "mapping" : typeof v;
var REGEX_FLAGS = { pre_bash: "", pre_edit: "m", post_edit: "m" };
function normalizeEnforce(io, raw) {
  const t = tr(io.lang);
  const problems = [];
  if (!truthy(raw))
    return { enforce: [], problems };
  if (!Array.isArray(raw))
    return { enforce: [], problems: [t("rules.enforceNotList", { type: typeName(raw) })] };
  const enforce = [];
  raw.forEach((entry, index) => {
    if (!isDict(entry)) {
      problems.push(t("rules.enforceItemNotMapping", { index, type: typeName(entry) }));
      return;
    }
    const flags = typeof entry.event === "string" ? REGEX_FLAGS[entry.event] : undefined;
    if (flags !== undefined) {
      for (const key of ["when", "unless"]) {
        const v = entry[key];
        if (!truthy(v))
          continue;
        try {
          pyRegExp(String(v), flags);
        } catch (e) {
          problems.push(t("rules.badRegex", { index, key, error: errorText(e) }));
          return;
        }
      }
    }
    enforce.push(entry);
  });
  return { enforce, problems };
}
var errorText = (e) => (e instanceof Error ? e.message : String(e)).split(`
`)[0]?.trim() ?? "";
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
  const { enforce, problems } = normalizeEnforce(io, data.enforce);
  return {
    name: String(data.name),
    description: truthy(data.description) ? String(data.description) : "",
    count: toCount(data.count),
    enforce,
    ...problems.length > 0 ? { problems } : {},
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
async function listRulesIn(io, d, broken) {
  const rules = [];
  const names = (await io.list(d)).map((e) => e.name).sort();
  for (const name of names) {
    if (!name.endsWith(".md"))
      continue;
    const path = join(d, name);
    try {
      const rule = await loadRule(io, path);
      if (rule)
        rules.push(rule);
    } catch (e) {
      broken.push({ path, reason: tr(io.lang)("rules.unreadable", { error: errorText(e) }) });
    }
  }
  return rules;
}
var problemsOf = (rules) => rules.flatMap((r) => (r.problems ?? []).map((reason) => ({ path: r.path, reason })));
async function listRules(io, feedbackDirPath) {
  const { rules, broken } = await scanRules(io, feedbackDirPath);
  for (const b of broken)
    await logError(io, "rules", b.reason, b.path);
  return rules;
}
async function scanRules(io, feedbackDirPath) {
  const broken = [];
  if (feedbackDirPath) {
    const rules = await listRulesIn(io, feedbackDirPath, broken);
    return { rules, broken: [...broken, ...problemsOf(rules)] };
  }
  const globalDir = feedbackDir(io);
  const projectDir = projectFeedbackDir(io);
  const globalRules = await listRulesIn(io, globalDir, broken);
  let merged = globalRules;
  if (projectDir !== globalDir) {
    const projectRules = await listRulesIn(io, projectDir, broken);
    const overridden = new Set(projectRules.map((r) => r.name));
    merged = [...globalRules.filter((r) => !overridden.has(r.name)), ...projectRules];
  }
  const active = [];
  for (const r of merged)
    if (await isRuleActive(io, r))
      active.push(r);
  return { rules: active, broken: [...broken, ...problemsOf(active)] };
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
function logError(io, source, error, file) {
  const task = logQueue.then(async () => {
    try {
      const path = errorsLogPath(io);
      const existing = await io.readFile(path) ?? "";
      const same = (line) => {
        try {
          const d = JSON.parse(line);
          return isDict(d) && d.source === source && d.error === error && (d.file ?? undefined) === file;
        } catch {
          return false;
        }
      };
      if (existing.split(`
`).some(same))
        return;
      const ts = new Date(await io.now()).toISOString().replace("Z", "+00:00");
      const entry = { ts, source, ...file !== undefined ? { file } : {}, error };
      await io.writeFile(path, `${existing}${JSON.stringify(entry)}
`);
    } catch {}
  });
  logQueue = task;
  return task;
}
async function logEntryError(io, rule, index, e) {
  await logError(io, "enforce", tr(io.lang)("rules.evalError", { index, error: errorText(e) }), rule.path);
}
var AUTO_COUNT_MAX = 5;
var COUNT_LINE_RE = /^count:[ \t]*(\d+)[ \t]*(?=\r?$)/m;
function readCountLine(content) {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm)
    return;
  const m = COUNT_LINE_RE.exec(fm[0]);
  return m ? Number(m[1]) : undefined;
}
function replaceCountLine(content, to) {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm)
    return;
  const head = fm[0];
  if (!COUNT_LINE_RE.test(head))
    return;
  return head.replace(COUNT_LINE_RE, `count: ${to}`) + content.slice(head.length);
}
async function writeFileAtomic(io, path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${Math.floor(await io.now())}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await io.writeFile(tmp, text);
    const r = await io.run(["mv", "-f", "--", tmp, path], { timeoutMs: 5000 });
    if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
      return;
  } catch {}
  await io.removeFiles([tmp]).catch(() => {
    return;
  });
  await io.writeFile(path, text);
}
var countStatePath = (io, sessionId) => join(feedbackDir(io), ".count_state", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
async function loadBumpedRules(io, sessionId) {
  try {
    const text = await io.readFile(countStatePath(io, sessionId));
    if (text === undefined)
      return new Set;
    const data = JSON.parse(text);
    if (isDict(data) && Array.isArray(data.bumped))
      return new Set(data.bumped.map(String));
  } catch {}
  return new Set;
}
async function autoBumpCounts(io, rules, violations, sessionId) {
  const bumps = [];
  if (io.autoCount === false || !truthy(sessionId) || violations.length === 0)
    return bumps;
  try {
    const sid = String(sessionId);
    const done = await loadBumpedRules(io, sid);
    const names = [...new Set(violations.map((v) => v.rule))].filter((n) => !done.has(n));
    if (names.length === 0)
      return bumps;
    for (const name of names) {
      const rule = rules.find((r) => r.name === name);
      if (!rule)
        continue;
      try {
        const content = await io.readFile(rule.path);
        if (content === undefined)
          continue;
        const from = readCountLine(content);
        if (from === undefined || from >= AUTO_COUNT_MAX)
          continue;
        const next = replaceCountLine(content, from + 1);
        if (next === undefined)
          continue;
        await writeFileAtomic(io, rule.path, next);
        bumps.push({ rule: name, path: rule.path, from, to: from + 1 });
        done.add(name);
      } catch {}
    }
    if (bumps.length > 0)
      await io.writeFile(countStatePath(io, sid), JSON.stringify({ bumped: [...done].sort() }));
  } catch {}
  return bumps;
}
var countBumpNotes = (lang, bumps) => bumps.map((b) => tr(lang)("autoCount.bumped", { rule: b.rule, from: b.from, to: b.to, path: b.path }));
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
async function evalEntries(io, rules, event, fn) {
  const violations = [];
  for (const rule of rules) {
    const entries = Array.isArray(rule.enforce) ? rule.enforce : [];
    for (const [index, entry] of entries.entries()) {
      if (!isDict(entry) || entry.event !== event)
        continue;
      try {
        const v = await fn(rule, entry);
        if (v)
          violations.push(v);
      } catch (e) {
        await logEntryError(io, rule, index, e);
      }
    }
  }
  return violations;
}
async function evalPreBash(io, rules, command, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  if (!command)
    return [];
  return evalEntries(io, rules, "pre_bash", async (rule, entry) => {
    const when = entry.when;
    if (!truthy(when) || !pyRegExp(String(when)).test(command))
      return;
    const unless = entry.unless;
    if (truthy(unless) && pyRegExp(String(unless)).test(command))
      return;
    const checkCmd = entry.check;
    if (truthy(checkCmd)) {
      io.progress?.(tr(io.lang)("guard.evaluating", { rule: rule.name }));
      const r = await io.run([...SHELL, String(checkCmd)], { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir }, timeoutMs: 1e4 });
      if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
        return;
    }
    return {
      rule: rule.name,
      count: rule.count,
      severity: resolveSeverity(rule.count, entry.severity, "pre_bash"),
      event: "pre_bash",
      message: truthy(entry.message) ? String(entry.message) : "",
      detail: `command matched: ${String(when)}`
    };
  });
}
async function evalPreEdit(io, rules, filePath, content, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  const [root, rel] = splitRoot(dir, filePath);
  const name = basename(filePath);
  const text = content || "";
  return evalEntries(io, rules, "pre_edit", async (rule, entry) => {
    const patterns = asList(entry.path);
    if (patterns.length === 0)
      return;
    if (!compileGlobs(patterns).some((rx) => rx.test(rel)))
      return;
    const exclPatterns = asList(entry.exclude_path);
    if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel)))
      return;
    const absentSibling = entry.absent_sibling;
    const absentGlobs = asList(entry.absent_glob);
    let detail;
    if (truthy(absentSibling) || absentGlobs.length > 0) {
      if (looksLikeTestFile(name))
        return;
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
        return;
      detail = `missing test file: ${candidates.join(", ")}`;
    } else {
      const when = entry.when;
      if (!truthy(when) || !pyRegExp(String(when), "m").test(text))
        return;
      const unless = entry.unless;
      if (truthy(unless) && pyRegExp(String(unless), "m").test(text))
        return;
      detail = `content matched: ${String(when)}`;
    }
    return {
      rule: rule.name,
      count: rule.count,
      severity: resolveSeverity(rule.count, entry.severity, "pre_edit"),
      event: "pre_edit",
      message: truthy(entry.message) ? String(entry.message) : "",
      detail
    };
  });
}
async function evalPostEdit(io, rules, filePath, projectDir) {
  const dir = projectDir || io.projectDir || io.cwd;
  const [root, rel] = splitRoot(dir, filePath);
  const absPath = isAbsolute(filePath) ? filePath : join(dir, filePath);
  let text;
  let unreadable = false;
  return evalEntries(io, rules, "post_edit", async (rule, entry) => {
    if (unreadable)
      return;
    const patterns = asList(entry.path);
    if (patterns.length === 0)
      return;
    if (!compileGlobs(patterns).some((rx) => rx.test(rel)))
      return;
    const exclPatterns = asList(entry.exclude_path);
    if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel)))
      return;
    const when = entry.when;
    const checkCmd = entry.check;
    if (!truthy(when) && !truthy(checkCmd))
      return;
    if (text === undefined) {
      text = await io.readFile(absPath);
      if (text === undefined) {
        unreadable = true;
        return;
      }
    }
    const details = [];
    if (truthy(when)) {
      if (!pyRegExp(String(when), "m").test(text))
        return;
      const unless = entry.unless;
      if (truthy(unless) && pyRegExp(String(unless), "m").test(text))
        return;
      details.push(`content matched: ${String(when)}`);
    }
    if (truthy(checkCmd)) {
      io.progress?.(tr(io.lang)("postEdit.checking", { rule: rule.name, file: absPath }));
      const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: dir, FILE: absPath }, timeoutMs: 15000 });
      if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
        return;
      details.push(`check failed: ${String(checkCmd)}`);
    }
    return {
      rule: rule.name,
      count: rule.count,
      severity: resolveSeverity(rule.count, entry.severity, "post_edit"),
      event: "post_edit",
      message: truthy(entry.message) ? String(entry.message) : "",
      detail: details.join(", ")
    };
  });
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
  return evalEntries(io, rules, "stop_check", async (rule, entry) => {
    const patterns = asList(entry.changed);
    if (patterns.length === 0)
      return;
    const rxs = compileGlobs(patterns);
    const matchedKeys = new Set;
    for (const [root, rel] of keyed)
      if (rxs.some((rx) => rx.test(rel)))
        matchedKeys.add(`${root}\x00${rel}`);
    const matched = [...matchedKeys].sort().map((k) => k.split("\x00"));
    if (matched.length === 0)
      return;
    const checkCmd = entry.check;
    const requireSibling = entry.require_sibling;
    const badFiles = [];
    for (const [root, rel] of matched) {
      const absPath = join(root, rel);
      if (!await io.exists(absPath))
        continue;
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
        io.progress?.(tr(io.lang)("stopCheck.checking", { rule: rule.name, file: absPath }));
        const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: projectDir, FILE: absPath }, timeoutMs: 15000 });
        if (r.exitCode !== 0 || r.timedOut || r.error !== undefined)
          bad = true;
      }
      if (bad)
        badFiles.push(root === projectDir ? rel : `${basename(root)}/${rel}`);
    }
    if (badFiles.length === 0)
      return;
    return {
      rule: rule.name,
      count: rule.count,
      severity: resolveSeverity(rule.count, entry.severity, "stop_check"),
      event: "stop_check",
      message: truthy(entry.message) ? String(entry.message) : "",
      detail: `changed files violating: ${badFiles.join(", ")}`
    };
  });
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
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id));
  const noteText = notes.map((l) => `${l}
`).join("");
  const warnings = violations.filter((v) => v.severity === "warn");
  const blocking = violations.filter((v) => v.severity !== "warn");
  let stderr = warnings.map((v) => `[feedback-stop-check] warn: ${v.rule} (count: ${v.count}): ${v.message}
`).join("");
  if (blocking.length === 0) {
    await io.removeFiles([ap]);
    return ok("", stderr + noteText);
  }
  const attempts = await bumpAttempts(io, ap);
  if (attempts >= MAX_ATTEMPTS) {
    stderr += `${tr(io.lang)("stopCheck.gaveUp", { max: MAX_ATTEMPTS })}
`;
    await io.removeFiles([ap]);
    return ok("", stderr + noteText);
  }
  const lines = [...blocking.map((v) => `[feedback-stop-check] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`), ...notes];
  lines.push(tr(io.lang)("stopCheck.fixAbove", { attempt: attempts, max: MAX_ATTEMPTS }));
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
    await logError(io, "feedback-stop-check", errorText(e));
    return ok("", `[feedback-stop-check] internal error (ignored): ${errorText(e)}
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
  notify: { label: "notify.waiting", fallback: "notify.waitingFallback" },
  stop: { label: "notify.done", fallback: "notify.doneFallback" }
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
function finishedSummary(entries, lang) {
  if (entries.length === 0 || entries.some((e) => !e.result))
    return;
  const passed = entries.filter((e) => e.result === "ok").length;
  const failed = entries.length - passed;
  const counts = [passed > 0 ? `✓ ${passed}` : "", failed > 0 ? `✗ ${failed}` : ""].filter((s) => s !== "").join(" / ");
  const first = Math.min(...entries.map((e) => e.started));
  const last = Math.max(...entries.map((e) => e.ended ?? e.started));
  return tr(lang)("band.done", { counts, seconds: ((last - first) / 1000).toFixed(1) });
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
var DEAD_GRACE_MS = 1500;
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
var sharedDirCache = new Map;
function sharedDir(io) {
  const base = io.projectDir || io.cwd;
  const home = io.env.HOME;
  const cacheKey = JSON.stringify([home, base]);
  let cached = sharedDirCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      if (!home)
        return join(gateStatusDir(io), "shared");
      const ask = async (args) => {
        try {
          const r = await io.run(["git", "-C", base, "rev-parse", ...args, "--git-common-dir"], { timeoutMs: 1e4 });
          const out = r.stdout.trim();
          return r.exitCode === 0 && out && !out.includes(`
`) ? out : undefined;
        } catch {
          return;
        }
      };
      const common = await ask(["--path-format=absolute"]) ?? await ask([]);
      const anchor = common ? normpath(isAbsolute(common) ? common : join(base, common)) : normpath(base);
      const label = (common && basename(anchor) === ".git" ? basename(dirname(anchor)) : basename(anchor)).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
      return join(home, ".claude", ".gate-status", "shared", `${label}-${hashKey(anchor)}`);
    })();
    sharedDirCache.set(cacheKey, cached);
  }
  return cached;
}
var normalizeFiles = (files) => [...new Set(files)].sort();
var shareId = (key, files) => `${hashKey(key)}.${hashKey(JSON.stringify(normalizeFiles(files)))}`;
async function runShared(io, key, files, timeoutMs, execute, hooks = {}) {
  const mine = normalizeFiles(files);
  const dir = await sharedDir(io);
  const keyPrefix = `${hashKey(key)}.`;
  const ownLock = join(dir, `${shareId(key, mine)}.run`);
  const resultOf = (lock) => `${lock.slice(0, -".run".length)}.result.json`;
  const serialLock = join(dir, `${hashKey(hooks.serial ?? key)}.serial`);
  const mkdirAtomic = async (path) => (await io.run(["sh", "-c", 'mkdir -p "$1" && mkdir "$2"', "sh", dir, path])).exitCode === 0;
  const claim = () => mkdirAtomic(ownLock);
  const lead = async () => {
    const resultFile = resultOf(ownLock);
    try {
      const started = await io.now();
      await io.writeFile(join(ownLock, "info.json"), JSON.stringify({ started, timeoutMs, key, files: mine }));
      await io.writeFile(join(serialLock, "info.json"), JSON.stringify({ started, timeoutMs }));
      await io.removeFiles([resultFile]);
      try {
        const outcome = await execute([join(serialLock, "pid"), join(ownLock, "pid")]);
        await io.writeFile(resultFile, JSON.stringify({ key, files: mine, ...outcome }));
        return outcome;
      } finally {
        await io.removeTree(ownLock);
      }
    } finally {
      await io.removeTree(serialLock);
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
    const now = await io.now();
    const started = info?.started ?? (await io.stat(lock))?.mtimeMs ?? now;
    const left = started + (info?.limit ?? 0) + GRACE_MS - now;
    if (left <= 0)
      return left;
    const pid = (await io.readFile(join(lock, "pid")))?.trim();
    if (pid) {
      if (/^\d+$/.test(pid) && (await io.run(["sh", "-c", 'kill -0 "$1" 2>/dev/null', "sh", pid])).exitCode === 0)
        return left;
      const polls = Math.ceil(DEAD_GRACE_MS / (Number(POLL_SECONDS) * 1000));
      const script = `i=0; while [ -d "$1" ] && [ "$i" -lt ${polls} ]; do sleep ${POLL_SECONDS}; i=$((i+1)); done; [ ! -d "$1" ]`;
      return (await io.run(["sh", "-c", script, "sh", lock])).exitCode === 0 ? GRACE_MS : 0;
    }
    return info && now - started > GRACE_MS ? 0 : left;
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
  const announce = async () => {
    if (announced)
      return;
    announced = true;
    await hooks.onWait?.();
  };
  const waitGone = async (path, left) => {
    const script = `while [ -d "$1" ]; do if [ -s "$1/pid" ] && ! kill -0 "$(cat "$1/pid")" 2>/dev/null; then exit 3; fi; sleep ${POLL_SECONDS}; done`;
    await io.run(["sh", "-c", script, "sh", path], { timeoutMs: Math.min(Math.max(left, 1), MAX_WAIT_MS) });
  };
  for (let round = 0;round < MAX_ROUNDS; round++) {
    const found = await findRunning();
    if (!found.lock && found.pending) {
      await io.run(["sleep", POLL_SECONDS]);
      round--;
      continue;
    }
    let target = found.lock;
    if (!target) {
      if (!await mkdirAtomic(serialLock)) {
        const info = await readInfo(serialLock);
        const left = await remainingMs(serialLock, info);
        if (left <= 0) {
          await io.removeTree(serialLock);
          continue;
        }
        if (!info) {
          if (!await io.exists(serialLock))
            continue;
          await io.run(["sleep", POLL_SECONDS]);
          round--;
          continue;
        }
        const again = await findRunning();
        if (!again.lock) {
          await announce();
          await waitGone(serialLock, left);
          continue;
        }
        target = again.lock;
      } else if (await claim()) {
        return { outcome: await lead(), shared: false };
      } else {
        await io.removeTree(serialLock);
        target = ownLock;
      }
    }
    const left = await remainingMs(target, await readInfo(target));
    if (left <= 0) {
      await io.removeTree(target);
      continue;
    }
    await announce();
    await waitGone(target, left);
    if (await io.exists(target))
      continue;
    const outcome = await readOutcome(resultOf(target));
    if (outcome)
      return { outcome, shared: true };
  }
  return { outcome: await execute([]), shared: false };
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
var serialKey = (name, cmd) => name ? `name:${name}` : `cmd:${cmd}`;
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
  return [tr(lang)("gate.headOmitted", { n: lines.length - limit }), ...lines.slice(-limit)].join(`
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
${t("gate.restOmitted")}`;
    text += `${d}
`;
    used += d.length + 1;
  }
  if (omitted)
    text += `${t("gate.failuresOmitted", { n: omitted })}
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
  failed;
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
  report;
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
    this.failed = join(this.stateDir, `gate_failed.${this.stateId}.txt`);
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
    await this.io.removeFiles(only ?? [this.changed, this.count, this.sidecar, this.pending, this.reported, this.failed]);
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
      const old = (await this.io.list(dir)).filter((e) => e.kind === "file" && e.name.endsWith(suffix) && e.mtimeMs < now - maxAge * 1000).map((e) => join(dir, e.name));
      if (old.length > 0)
        await this.io.removeFiles(old);
    };
    await stale(await sharedDir(this.io), ".result.json", LOG_STALE_GRACE);
    await stale(join(this.stateDir, "running"), ".json", LOG_MAX_AGE);
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
        logs.push(this.t("gate.policyNotFound", { policy }));
      }
      return null;
    }
    const schema = this.resolvePolicyPath(rootDir, owner?.policy_schema || cfg?.policy_schema);
    return { policy, schema: schema || this.defaultPolicySchema, isDefault };
  }
  async dogwoodVerdict(policy, schema, rootDir, name, cmd) {
    const binpath = await this.resolveDogwood();
    if (!binpath)
      return [null, this.t("dogwood.notFound")];
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
      return [null, this.t("dogwood.runFailed", { error: r.error ?? "timed out" })];
    }
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || "").trim().replaceAll(`
`, " ").slice(0, 200);
      return [null, this.t("dogwood.exited", { code: r.exitCode, detail })];
    }
    let verdicts;
    try {
      const parsed = JSON.parse(r.stdout);
      const v = isDict(parsed) ? parsed.verdicts : undefined;
      verdicts = Array.isArray(v) ? v : [];
    } catch {
      return [null, this.t("dogwood.badJson")];
    }
    if (verdicts.length === 0)
      return [null, this.t("dogwood.noVerdict")];
    const last = verdicts[verdicts.length - 1];
    const verdict = String((isDict(last) ? last.verdict : "") || "").toLowerCase();
    if (verdict !== "allow" && verdict !== "deny")
      return [null, this.t("dogwood.badVerdict", { verdict: pyRepr(verdict) })];
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
  async runCmd(cmd, cwd, timeout, name, extraEnv, pidFiles = []) {
    const uid = `${Math.floor(await this.io.now() / 1000)}-${logSeq++}`;
    const logpath = join(this.logDir, `${slug(name || cmd)}.${uid}.log`);
    const header = `$ ${cmd}  (cwd: ${cwd})
`;
    await this.io.writeFile(logpath, header).catch(() => {
      return;
    });
    const started = await this.io.now();
    const writePid = pidFiles.map((f) => `{ echo $$ > ${shellQuote(f)}; } 2>/dev/null; `).join("");
    const r = await this.io.run(["sh", "-c", `${writePid}exec 2>&1; ${cmd}`], {
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
    const r = await runShared(this.io, key, shareFiles(env, scope.files !== false), Math.min(Math.round(timeout * 1000), MAX_TIMEOUT_MS), (pidFiles) => this.runCmd(cmd, cwd, timeout, name, extraEnv, pidFiles), {
      onWait,
      serial: serialKey(name, cmd)
    });
    if (!r.shared)
      return r.outcome;
    const uid = `${Math.floor(await this.io.now() / 1000)}-${logSeq++}`;
    const logpath = join(this.logDir, `${slug(name || cmd)}.${uid}.log`);
    const header = `$ ${cmd}  (cwd: ${cwd})
${this.t("gate.sharedResult", { logpath: r.outcome.logpath })}
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
      const msg = this.t("gate.timeout", { seconds: timeout });
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

${this.t("gate.failedOutputHeader")}
${details}` : "");
  }
  async runParallel(label, items, cwd, defaultTimeout, logs, policy, extraEnv, root = policy?.rootDir ?? this.projectDir) {
    let failed = false;
    const tasks = [];
    for (const item of items) {
      if (isParallel(item)) {
        logs.push(this.t("gate.nestedParallel", { label }));
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
        logs.push(this.t("gate.deferredNoCwd", { label, cwd }));
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
      throw new Error(this.t("gate.cannotReadYaml", { path }));
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
    const more = unmatched.length > UNMATCHED_SHOWN ? this.t("gate.andMore", { n: unmatched.length - UNMATCHED_SHOWN }) : "";
    this.status.push(this.t("gate.skipUnmatched", { files: `${shown}${more}` }));
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
          logs.push(this.t("gate.badPerFileDir", { value: pyRepr(rawPerFileDir) }));
          summary.push(`${summarizeCmds(cmds)}  ${this.t("gate.skipBadPerFileDir")}`);
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
            logs.push(this.t("gate.rootNoCwd", { label, cwd }));
            summary.push(`(${label}) ${summarizeCmds(cmds)}  ${this.t("gate.skipNoCwd")}`);
            this.note("skip", label, summarizeCmds(cmds), this.t("gate.noteNoCwd"));
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
          logs.push(this.t("gate.ruleNoCwd", { label, cwd }));
          summary.push(`(${label}) ${summarizeCmds(cmds)}  ${this.t("gate.skipNoCwd")}`);
          this.note("skip", label, summarizeCmds(cmds), this.t("gate.noteNoCwd"));
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
        logs.push(this.t("gate.worktreeNotFound", { root }));
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
  async applyRulesResult(keys, rawByKey, res) {
    if (res.checkNamesByRoot.size > 0)
      await this.mergePendingChecks(res.checkNamesByRoot, res.checkRefKeysByRoot, rawByKey);
    const checkedKeys = new Set;
    for (const ref of res.checkRefKeysByRoot.values())
      for (const ks of ref.values())
        for (const k of ks)
          checkedKeys.add(k);
    const remaining = [];
    const seen = new Set;
    const sidecarAdd = [];
    const seenSidecar = new Set;
    for (const k of keys) {
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
    const ran = new Set(keys);
    const changed = await this.loadChangedFlat(this.changed);
    const changedRaw = new Map([...changed.rawByKey, ...rawByKey]);
    await this.writeChangedFlat(this.changed, [...new Set([...changed.order.filter((k) => !ran.has(k)), ...remaining])], changedRaw);
    if (sidecarAdd.length > 0) {
      const existing = await this.loadChangedFlat(this.sidecar);
      const merged = [...new Set([...existing.order, ...sidecarAdd])];
      const rawLookup = new Map([...existing.rawByKey, ...rawByKey]);
      await this.writeChangedFlat(this.sidecar, merged, rawLookup);
    }
    const failedNow = keys.filter((k) => res.failKeys.has(k) && !res.consumedKeys.has(k));
    const prev = await this.loadChangedFlat(this.failed);
    const failedRaw = new Map([...prev.rawByKey, ...rawByKey]);
    await this.writeChangedFlat(this.failed, [...new Set([...prev.order.filter((k) => !ran.has(k)), ...failedNow])], failedRaw);
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
    await this.applyRulesResult(order, rawByKey, res);
    if (failed) {
      this.writeErr(`${[...this.status, ...logs].join(`
`)}
`);
      this.writeErr(`${this.t("gate.rulesFailed")}
`);
      return 2;
    }
    if (summary.length > 0 || this.status.length > 0) {
      const body = this.statusBlock(summary.map((s) => `✓ ${s}`).join(`
`));
      this.print({ systemMessage: this.t("gate.rulesPassed", { body }) });
    }
    return 0;
  }
  async runNamedChecks(checksByName, names, logs, rootDir, cfg, policyState, filesByName) {
    const summary = [];
    let failed = false;
    for (const name of [...names].sort()) {
      const check = checksByName.get(name);
      if (!check) {
        logs.push(this.t("gate.checkNotFound", { name }));
        summary.push(this.t("gate.checkNotFoundSummary", { name }));
        this.status.push(this.t("gate.skipCheckUndefined", { name }));
        continue;
      }
      const cwd = check.dir ? join(rootDir, check.dir) : rootDir;
      const cmds = check.run || [];
      const timeout = check.timeout || DEFAULT_TIMEOUT;
      if ((await this.io.stat(cwd))?.kind !== "dir") {
        logs.push(this.t("gate.checkNoCwd", { name, cwd }));
        summary.push(`(check:${name}) ${summarizeCmds(cmds)}  ${this.t("gate.skipNoCwd")}`);
        this.note("skip", `check:${name}`, summarizeCmds(cmds), this.t("gate.noteNoCwd"));
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
    const failedFiles = await this.loadChangedFlat(this.failed);
    if (failedFiles.order.length === 0)
      await this.rm(this.failed);
    if (failedFiles.order.length === 0 && !await this.io.exists(this.pending) && !await this.io.exists(this.deferred))
      return 0;
    const mainCfg = await this.loadAction(this.action);
    const logs = [];
    const summary = [];
    let failed = false;
    const policyState = new PolicyState;
    if (failedFiles.order.length > 0) {
      const { order: rootOrder, relsByRoot } = this.groupKeysByRoot(failedFiles.order);
      const res = await this.runRulesAllRoots(rootOrder, relsByRoot, mainCfg, logs, policyState);
      summary.push(...res.summary);
      if (res.failed)
        failed = true;
      await this.applyRulesResult(failedFiles.order, failedFiles.rawByKey, res);
    }
    const pending = await this.io.exists(this.pending) ? await this.loadPending() : {};
    if (Object.keys(pending).length === 0)
      await this.rm(this.pending);
    const deferred = await this.takeDeferred();
    if (failedFiles.order.length === 0 && Object.keys(pending).length === 0 && deferred.length === 0)
      return 0;
    const activePending = {};
    const droppedRoots = new Set;
    for (const [root, checksMap] of Object.entries(pending)) {
      if (root !== this.projectDir && (await this.io.stat(root))?.kind !== "dir") {
        logs.push(this.t("gate.worktreeNotFound", { root }));
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
`) : this.t("gate.nothingToRun"));
      if (this.executedLabels.length > 0 && !this.stopHookActive && mainCfg?.report_success !== false) {
        await this.io.writeFile(this.reported, `1
`);
        const labels = this.executedLabels.map((l) => `${l} ✓`).join(" / ");
        const reason = this.t("gate.allPassed", { labels });
        this.report = this.t("gate.passedReport", { labels });
        this.writeErr(`${reason}
`);
        this.print({ decision: "block", reason });
        return 2;
      }
      const title = Object.keys(pending).length > 0 ? "consistency checks" : failedFiles.order.length > 0 ? "rules" : this.t("gate.deferredTitle");
      this.report = this.t("gate.checksPassed", { title, body });
      this.print({ systemMessage: this.report });
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
      await this.cleanup([this.count, this.pending, this.failed]);
      this.writeErr(`${this.t("gate.checksGaveUpStderr", { max: MAX_ATTEMPTS2 })}
`);
      const msg = `${this.t("gate.checksGaveUp", { max: MAX_ATTEMPTS2 })}
${summary.map((s) => `✗ ${s}`).join(`
`)}${this.withDetails("")}`;
      this.report = msg;
      this.print({ systemMessage: msg });
      return 0;
    }
    const reason = `${this.t("gate.checksFailed", { attempt: attempts, max: MAX_ATTEMPTS2 })}
${summary.map((s) => `✗ ${s}`).join(`
`)}${this.withDetails("")}`;
    this.writeErr(`${reason}
`);
    this.report = reason;
    this.print({ decision: "block", reason });
    return 2;
  }
  async main() {
    await this.pruneLogs();
    if (!await this.io.exists(this.action) && await this.io.exists(this.gateYml)) {
      this.print({ systemMessage: this.t("gate.ymlTypo") });
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
      logs.push(this.gate.t("gate.policyUnevaluated", { label, reason: reason ?? "", cmd }));
    } else {
      await this.gate.appendTrace(this.rootDir, cwd, pname, cmd, "request");
      if (verdict === "allow") {
        await this.gate.undeferCmd(this.rootDir, cwd, cmd);
        this.state.executed = true;
        this.state.allowedThisRun.add(`${this.rootDir}\x00${cwd}\x00${cmd}`);
        return true;
      }
      logs.push(this.gate.t("gate.policySkipped", { label, cmd }));
    }
    this.gate.note("skip", label, cmd, verdict ? this.gate.t("gate.notePolicySkipped") : this.gate.t("gate.notePolicyUnevaluated", { reason: reason ?? "" }));
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
    gate.report = tr(io.lang)("gate.internalError");
    gate.stdout += `${JSON.stringify({ systemMessage: gate.report })}
`;
    exitCode = 0;
  } finally {
    await gate.finishProgress();
  }
  return {
    exitCode,
    stdout: gate.stdout,
    stderr: gate.stderr,
    ...gate.reportConsumed ? { reportConsumed: true } : {},
    ...gate.report !== undefined ? { report: gate.report } : {}
  };
}

// src/stop-test-gate.ts
async function stopTestGate(io, phase, payload) {
  const projectDir = io.projectDir || io.cwd;
  if (!await io.exists(join(projectDir, ".claude", "gate.yaml"))) {
    if (await io.exists(join(projectDir, ".claude", "gate.yml"))) {
      return ok(`${JSON.stringify({ systemMessage: tr(io.lang)("gate.ymlTypo") })}
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
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id));
  const blocking = violations.filter((v) => v.severity !== "warn");
  const warnings = violations.filter((v) => v.severity === "warn");
  let stdout = "";
  if (blocking.length > 0) {
    const top = blocking.reduce((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a);
    stdout = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decisionFor(top.severity),
        permissionDecisionReason: [buildReason(blocking), ...notes].join(`
`)
      }
    })}
`;
  }
  const stderr = [...warnings.map((v) => `[feedback-guard] warn: ${v.rule} (count: ${v.count}): ${v.message}`), ...notes].map((l) => `${l}
`).join("");
  return ok(stdout, stderr);
}
async function feedbackGuard(io, payload) {
  try {
    return await main2(io, payload);
  } catch (e) {
    await logError(io, "feedback-guard", errorText(e));
    return ok("", `[feedback-guard] internal error (ignored): ${errorText(e)}
`);
  }
}

// src/feedback-bash-edit.ts
var EVENTS = new Set(["post_edit", "pre_edit"]);
var wantsBashEdits = (rules) => rules.some((r) => r.enforce.some((e) => isDict(e) && EVENTS.has(String(e.event))));
var hasPreEditContent = (rules) => rules.some((r) => r.enforce.some((e) => isDict(e) && e.event === "pre_edit" && truthy(e.when)));
function addedLines(diff) {
  const out = [];
  let inHunk = false;
  for (const line of diff.split(`
`)) {
    if (line.startsWith("diff --git "))
      inHunk = false;
    else if (line.startsWith("@@"))
      inHunk = true;
    else if (inHunk && line.startsWith("+"))
      out.push(line.slice(1));
  }
  return out;
}
async function writtenContent(io, file, threshold) {
  const dir = dirname(file);
  const name = basename(file);
  const opts = { timeoutMs: 1e4 };
  const whole = async () => await io.readFile(file) ?? "";
  const tracked = await io.run(["git", "-C", dir, "ls-files", "--error-unmatch", "--", name], opts);
  if (tracked.exitCode !== 0)
    return whole();
  const diff = await io.run(["git", "-C", dir, "diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", name], opts);
  if (diff.exitCode !== 0)
    return whole();
  let added = addedLines(diff.stdout);
  if (added.length === 0) {
    const since = `--since=@${Math.floor(threshold / 1000)}`;
    const log = await io.run(["git", "-C", dir, "log", since, "--no-merges", "-p", "--no-color", "--no-ext-diff", "-U0", "--format=", "--", name], opts);
    if (log.exitCode === 0)
      added = addedLines(log.stdout);
  }
  return added.join(`
`);
}
var label = (projectDir, file) => {
  if (!isAbsolute(file))
    return file;
  const rel = relpath(file, projectDir);
  return rel.startsWith("../") || rel === ".." ? file : rel;
};
async function main3(io, payload, files, threshold) {
  const rules = await listRules(io);
  if (!wantsBashEdits(rules))
    return ok();
  const projectDir = io.projectDir || io.cwd;
  const needContent = hasPreEditContent(rules);
  const found = [];
  for (const file of [...files].sort()) {
    const abs = isAbsolute(file) ? file : join(projectDir, file);
    for (const v of await evalPostEdit(io, rules, abs))
      found.push({ file: abs, v });
    const content = needContent ? await writtenContent(io, abs, threshold) : "";
    const pre = await evalPreEdit(io, rules, abs, content);
    if (pre.length === 0)
      continue;
    await downgradeRepeatedAsks(io, pre, payload.session_id, { file_path: abs });
    for (const v of pre)
      found.push({ file: abs, v });
  }
  if (found.length === 0)
    return ok();
  for (const { v } of found)
    await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail);
  const violations = found.map(({ v }) => v);
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id));
  const t = tr(io.lang);
  const tag = (v) => v.event === "pre_edit" ? "[feedback-guard]" : "[feedback-post-edit]";
  const after = (v) => v.event === "pre_edit" ? ` ${t("bashEdit.preEditAfter")}` : "";
  const warnings = found.filter(({ v }) => v.severity === "warn");
  const blocking = found.filter(({ v }) => v.severity !== "warn");
  let stderr = warnings.map(({ file, v }) => `${tag(v)} warn: ${v.rule} (count: ${v.count}): ${v.message} (${label(projectDir, file)})${after(v)}
`).join("");
  if (blocking.length === 0)
    return ok("", stderr + notes.map((l) => `${l}
`).join(""));
  const lines = blocking.map(({ file, v }) => `${tag(v)} ${v.rule} (count: ${v.count}): ${v.message} (${label(projectDir, file)}: ${v.detail})${after(v)}`);
  lines.unshift(t("bashEdit.header"));
  lines.push(...notes);
  stderr += lines.map((l) => `${l}
`).join("");
  return ok(`${JSON.stringify({ decision: "block", reason: lines.join(`
`) })}
`, stderr);
}
async function feedbackBashEdits(io, payload, files, threshold) {
  try {
    return await main3(io, payload, files, threshold);
  } catch (e) {
    await logError(io, "feedback-bash-edit", errorText(e));
    return ok("", `[feedback-bash-edit] internal error (ignored): ${errorText(e)}
`);
  }
}

// src/bash-changes.ts
var SKIP_COMMAND_RE = /\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+(rebase|checkout|switch|merge|pull|stash|reset|cherry-pick|revert|restore|clean|am|apply|worktree)\b/;
var MTIME_SLACK_MS = 2000;
var STALE_STARTED_MS = 2 * 60 * 60 * 1000;
var STATE_DIR = ".gate-status";
var stateIdOf = (payload) => {
  const sessionId = jqStr(payload.session_id) || "unknown";
  const agentId = jqStr(payload.agent_id);
  return agentId ? `${sessionId}--${agentId}` : sessionId;
};
var startedKey = (payload) => {
  const toolUseId = jqStr(payload.tool_use_id).replace(/[^A-Za-z0-9_.-]/g, "_");
  if (toolUseId === "")
    return stateIdOf(payload);
  const sessionId = jqStr(payload.session_id) || "unknown";
  return `${sessionId}--${toolUseId}`;
};
var hasGate = (io, projectDir) => io.exists(join(projectDir, ".claude", "gate.yaml"));
var startedDir = (io, projectDir, gate) => gate ? join(projectDir, ".claude", STATE_DIR) : join(feedbackDir(io), ".bash_started");
var startedPath = (dir, payload) => join(dir, `bash_started.${startedKey(payload)}.json`);
async function bashStarted(io, payload) {
  try {
    const projectDir = io.projectDir || io.cwd;
    const gate = await hasGate(io, projectDir);
    if (!gate && !wantsBashEdits(await listRules(io)))
      return ok();
    const dir = startedDir(io, projectDir, gate);
    const started = await io.now();
    await io.writeFile(startedPath(dir, payload), `${JSON.stringify({ tool_use_id: jqStr(payload.tool_use_id), started })}
`);
    await sweepStale(io, dir, jqStr(payload.session_id) || "unknown", started);
  } catch {}
  return ok();
}
async function sweepStale(io, stateDir, sessionId, now) {
  const prefix = `bash_started.${sessionId}--`;
  const stale = (await io.list(stateDir)).filter((e) => e.kind === "file" && e.name.startsWith(prefix) && e.name.endsWith(".json") && e.mtimeMs < now - STALE_STARTED_MS).map((e) => join(stateDir, e.name));
  if (stale.length > 0)
    await io.removeFiles(stale);
}
var NONE = { changed: [], recorded: [], threshold: 0, gate: false };
async function detectBashChanges(io, payload) {
  try {
    const projectDir = io.projectDir || io.cwd;
    const gate = await hasGate(io, projectDir);
    const dir = startedDir(io, projectDir, gate);
    const startedFile = startedPath(dir, payload);
    const raw = await io.readFile(startedFile);
    if (raw === undefined)
      return NONE;
    try {
      return await detect(io, projectDir, gate, dir, raw, payload);
    } finally {
      await io.removeFiles([startedFile]);
    }
  } catch {
    return NONE;
  }
}
async function detect(io, projectDir, gate, startedDirPath, raw, payload) {
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (!isDict(saved) || typeof saved.started !== "number")
    return NONE;
  if (jqStr(saved.tool_use_id) !== jqStr(payload.tool_use_id))
    return NONE;
  const command = jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined);
  if (SKIP_COMMAND_RE.test(command))
    return NONE;
  const threshold = saved.started - MTIME_SLACK_MS;
  const stateDir = join(projectDir, ".claude", STATE_DIR);
  const picked = new Set;
  for (const root of await scanRoots(io, projectDir, jqStr(payload.cwd) || io.cwd, command)) {
    for (const rel of await candidates(io, root, threshold)) {
      const abs = join(root, rel);
      if (abs.startsWith(`${stateDir}/`) || abs.startsWith(`${startedDirPath}/`) || rel.startsWith(`.claude/${STATE_DIR}/`))
        continue;
      const st = await io.stat(abs);
      if (st?.kind === "file" && st.mtimeMs >= threshold)
        picked.add(abs);
    }
  }
  const changed = [...picked];
  if (changed.length === 0 || !gate)
    return { changed, recorded: [], threshold, gate };
  const memo = join(stateDir, `changed_files.${stateIdOf(payload)}.txt`);
  const existing = await io.readFile(memo) ?? "";
  const have = new Set(existing.split(`
`));
  const recorded = changed.filter((p) => !have.has(p));
  if (recorded.length > 0)
    await io.writeFile(memo, `${existing}${recorded.map((p) => `${p}
`).join("")}`);
  return { changed, recorded, threshold, gate };
}
var gitTop = async (io, dir) => {
  const top = await io.run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 1e4 });
  return top.exitCode === 0 ? top.stdout.replace(/\n+$/, "") : "";
};
var mentionsWorktree = (command, name) => {
  const needle = `worktrees/${name}`;
  for (let i = command.indexOf(needle);i >= 0; i = command.indexOf(needle, i + 1)) {
    const next = command.charAt(i + needle.length);
    if (!/[A-Za-z0-9._-]/.test(next))
      return true;
  }
  return false;
};
async function scanRoots(io, projectDir, cwd, command) {
  const roots = [];
  const add = (top) => {
    if (top !== "" && !roots.includes(top))
      roots.push(top);
  };
  add(await gitTop(io, cwd));
  const worktreesDir = join(projectDir, ".claude", "worktrees");
  for (const e of await io.list(worktreesDir)) {
    if (e.kind === "dir" && mentionsWorktree(command, e.name))
      add(await gitTop(io, join(worktreesDir, e.name)));
  }
  return roots;
}
async function candidates(io, root, threshold) {
  const out = new Set;
  const listed = await io.run(["git", "-C", root, "ls-files", "-z", "--modified", "--others", "--exclude-standard", "--full-name"], { timeoutMs: 1e4 });
  if (listed.exitCode === 0) {
    for (const s of listed.stdout.split("\x00"))
      if (s !== "" && !s.endsWith("/"))
        out.add(s);
  }
  const since = `--since=@${Math.floor(threshold / 1000)}`;
  const logged = await io.run(["git", "-C", root, "log", since, "--no-merges", "--name-only", "-z", "--format=", "HEAD"], { timeoutMs: 1e4 });
  if (logged.exitCode === 0) {
    for (const s of logged.stdout.split(/[\0\n]/))
      if (s !== "")
        out.add(s);
  }
  return [...out];
}
function bashChangeSteps(payload) {
  let found = NONE;
  return [
    async (io) => {
      found = await detectBashChanges(io, payload);
      return ok();
    },
    (io) => found.changed.length > 0 ? feedbackBashEdits(io, payload, found.changed, found.threshold) : Promise.resolve(ok()),
    (io) => found.recorded.length > 0 ? stopTestGate(io, "rules", payload) : Promise.resolve(ok())
  ];
}

// src/feedback-inject.ts
async function formatFull(io, rule) {
  const lines = [tr(io.lang)("inject.ruleTitle", { name: rule.name, count: rule.count }), rule.description];
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
  return tr(io.lang)("inject.header") + blocks.join(`

`);
}
function brokenRulesText(io, broken) {
  if (broken.length === 0)
    return "";
  return [tr(io.lang)("inject.brokenRules"), ...broken.map((b) => `- ${b.path}: ${b.reason}`)].join(`
`);
}
async function feedbackInject(io) {
  try {
    const { rules: all, broken } = await scanRules(io);
    for (const b of broken)
      await logError(io, "rules", b.reason, b.path);
    const rules = all.filter((r) => r.count >= 3);
    const parts = [brokenRulesText(io, broken)];
    if (rules.length > 0)
      parts.push(await buildOutput(io, rules));
    const text = parts.filter((p) => p !== "").join(`

`);
    return text === "" ? ok() : ok(text);
  } catch (e) {
    await logError(io, "feedback-inject", errorText(e));
    return ok("", `[feedback-inject] internal error (ignored): ${errorText(e)}
`);
  }
}

// src/feedback-post-edit.ts
async function main4(io, payload) {
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
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id));
  const warnings = violations.filter((v) => v.severity === "warn");
  const blocking = violations.filter((v) => v.severity !== "warn");
  let stderr = warnings.map((v) => `[feedback-post-edit] warn: ${v.rule} (count: ${v.count}): ${v.message}
`).join("");
  if (blocking.length === 0)
    return ok("", stderr + notes.map((l) => `${l}
`).join(""));
  const lines = [...blocking.map((v) => `[feedback-post-edit] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`), ...notes];
  stderr += lines.map((l) => `${l}
`).join("");
  const stdout = `${JSON.stringify({ decision: "block", reason: lines.join(`
`) })}
`;
  return ok(stdout, stderr);
}
async function feedbackPostEdit(io, payload) {
  try {
    return await main4(io, payload);
  } catch (e) {
    await logError(io, "feedback-post-edit", errorText(e));
    return ok("", `[feedback-post-edit] internal error (ignored): ${errorText(e)}
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
var merge = (first, second) => {
  const out = { ...second, ...first };
  const ctx = [...first.additionalContext ?? [], ...second.additionalContext ?? []];
  if (ctx.length > 0)
    out.additionalContext = ctx;
  else
    delete out.additionalContext;
  return out;
};
var outcomeToClassic = (event, outcome, stderr = "") => {
  const json = {};
  const specific = {};
  const context = (outcome.additionalContext ?? []).filter((c) => c.trim() !== "").join(`

`);
  if (event === "PreToolUse") {
    const decision = outcome.deny !== undefined ? "deny" : outcome.ask !== undefined ? "ask" : undefined;
    if (decision !== undefined) {
      specific.permissionDecision = decision;
      specific.permissionDecisionReason = outcome.deny ?? outcome.ask ?? "";
    }
  } else if (outcome.block !== undefined) {
    json.decision = "block";
    json.reason = outcome.block;
  }
  if (context !== "" && event !== "Stop" && event !== "SubagentStop" && event !== "Notification")
    specific.additionalContext = context;
  if (Object.keys(specific).length > 0)
    json.hookSpecificOutput = { hookEventName: event, ...specific };
  if (outcome.preventContinuation) {
    json.continue = false;
    if (outcome.stopReason !== undefined)
      json.stopReason = outcome.stopReason;
  }
  return { exitCode: 0, stdout: Object.keys(json).length > 0 ? `${JSON.stringify(json)}
` : "", stderr };
};

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
  ["gate_failed", ".txt"],
  ["bash_started", ".json"],
  ["feedback_gate_attempts", ".txt"],
  ["subagent_report", ".json"],
  ["summary", ".txt"]
];
var DAY_MS2 = 1440 * 60 * 1000;
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
      if (e.kind !== "file" || e.mtimeMs >= now - DAY_MS2)
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
      if (st && st.mtimeMs < now - DAY_MS2)
        await io.removeTree(join(logRoot, e.name));
    }
  }
  const seenDir = join(feedbackDir(io), ".classic_seen");
  await io.removeFiles((await io.list(seenDir)).filter((e) => e.kind === "file" && e.mtimeMs < now - DAY_MS2).map((e) => join(seenDir, e.name)));
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

// src/subagent-report.ts
var reportPath = (io, sessionId, agentId) => join(io.projectDir || io.cwd, ".claude", ".gate-status", `subagent_report.${sessionId}--${agentId}.json`);
var blockReason = (stdout) => {
  for (const line of stdout.split(`
`)) {
    try {
      const v = JSON.parse(line);
      if (isDict(v) && v.decision === "block" && typeof v.reason === "string")
        return v.reason;
    } catch {}
  }
  return "";
};
var feedbackText = (r) => (r.exitCode === 2 ? blockReason(r.stdout) || r.stderr : r.stderr).trim();
async function loadReport(io, path) {
  const text = await io.readFile(path);
  if (text === undefined)
    return;
  try {
    const v = JSON.parse(text);
    return isDict(v) ? v : undefined;
  } catch {
    return;
  }
}
async function saveSubagentReport(io, payload, gate, feedback) {
  try {
    const agentId = jqStr(payload.agent_id);
    if (agentId === "")
      return ok();
    const path = reportPath(io, jqStr(payload.session_id) || "unknown", agentId);
    const gateText = gate?.reportConsumed ? (await loadReport(io, path))?.gate ?? "" : (gate?.report ?? "").trim();
    const fbText = feedback ? feedbackText(feedback) : "";
    if (gateText === "" && fbText === "") {
      await io.removeFiles([path]);
      return ok();
    }
    const report = {
      ...jqStr(payload.agent_type) ? { agentType: jqStr(payload.agent_type) } : {},
      ...gateText ? { gate: gateText } : {},
      ...fbText ? { feedback: fbText } : {}
    };
    await io.writeFile(path, `${JSON.stringify(report)}
`);
  } catch {}
  return ok();
}
async function subagentReport(io, payload) {
  const response = payload.tool_response;
  const agentId = isDict(response) ? jqStr(response.agentId) : "";
  if (agentId === "")
    return ok();
  const path = reportPath(io, jqStr(payload.session_id) || "unknown", agentId);
  const report = await loadReport(io, path);
  await io.removeFiles([path]);
  if (!report || !report.gate && !report.feedback)
    return ok();
  const agent = report.agentType ? `${report.agentType} (${agentId})` : agentId;
  const body = [tr(io.lang)("subagentReport.header", { agent }), report.gate, report.feedback].filter((s) => s).join(`
`);
  return ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: body } })}
`);
}

// src/hooks.ts
var str = (v) => typeof v === "string" ? v : "";
var none = { outcome: {}, stderr: "" };
var PROGRESS_DELAY_MS = 3000;
async function runSteps(base, sessionId, event, steps, first = {}) {
  let acc = first;
  let stderr = "";
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
      if (!ran)
        continue;
      acc = merge(acc, toOutcome(event, ran));
      if (ran.exitCode === 0)
        stderr += ran.stderr;
    }
  } finally {
    cancelDelay?.();
    if (shown)
      base.progress?.(await loadSummary(base, sessionId));
  }
  return { outcome: acc, stderr };
}
var sessionStart = (io, sessionId, payload) => runSteps(io, sessionId, "SessionStart", [(i) => resetGate(i, payload)]);
async function userPromptSubmit(io, sessionId, options) {
  const text = await loadRules(io, options.rulesFile);
  return runSteps(io, sessionId, "UserPromptSubmit", [(i) => feedbackInject(i)], text === "" ? {} : { additionalContext: [text] });
}
var guardsTool = (options, tool) => options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool);
function preToolUse(io, sessionId, options, payload) {
  const tool = str(payload.tool_name);
  if (!guardsTool(options, tool))
    return Promise.resolve(none);
  const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool);
  const step = guardsAgents ? async (i) => agentLaunchGuard(payload, i.lang) : (i) => feedbackGuard(i, payload);
  return runSteps(io, sessionId, "PreToolUse", tool === "Bash" ? [(i) => bashStarted(i, payload), step] : [step]);
}
function postToolUse(io, sessionId, payload) {
  const tool = str(payload.tool_name);
  const run = (steps) => runSteps(io, sessionId, "PostToolUse", steps);
  if (/^(Agent|Task)$/.test(tool))
    return run([(i) => subagentReport(i, payload)]);
  if (tool === "Bash")
    return run(bashChangeSteps(payload));
  if (!/^(Write|Edit|MultiEdit)$/.test(tool))
    return Promise.resolve(none);
  return run([(i) => recordChanges(i, payload), (i) => feedbackPostEdit(i, payload), (i) => stopTestGate(i, "rules", payload)]);
}
var notification2 = (io, sessionId, payload) => runSteps(io, sessionId, "Notification", [(i) => notification(i, "notify", payload)]);
var stop = (io, sessionId, payload) => runSteps(io, sessionId, "Stop", [(i) => allStop(i, payload)]);
function subagentStop(io, sessionId, payload) {
  let gate;
  let feedback;
  return runSteps(io, sessionId, "SubagentStop", [
    async (i) => gate = await stopTestGate(i, "checks", payload),
    async (i) => feedback = await feedbackStopCheck(i, payload),
    (i) => saveSubagentReport(i, payload, gate, feedback)
  ]);
}

// src/node-io.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var kindOf = (s) => s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
function pickEnv(env) {
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    CLAUDE_FEEDBACK_DIR: env.CLAUDE_FEEDBACK_DIR,
    DOGWOOD_BIN: env.DOGWOOD_BIN,
    TERM_PROGRAM: env.TERM_PROGRAM,
    __CFBundleIdentifier: env.__CFBundleIdentifier,
    FEEDBACK_GATE_LANG: env.FEEDBACK_GATE_LANG,
    LC_ALL: env.LC_ALL,
    LC_MESSAGES: env.LC_MESSAGES,
    LANG: env.LANG
  };
}
function makeNodeIo(init) {
  const env = pickEnv(init.env);
  const cwd = init.payloadCwd || process.cwd();
  const stat = async (p) => {
    try {
      const s = fs.statSync(p);
      return { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return;
    }
  };
  return {
    env,
    lang: resolveLang(env, init.language),
    ...init.autoCount !== undefined ? { autoCount: init.autoCount } : {},
    projectDir: init.env.CLAUDE_PROJECT_DIR || cwd,
    cwd,
    pluginRoot: init.env.CLAUDE_PLUGIN_ROOT || process.cwd(),
    readFile: async (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return;
      }
    },
    writeFile: async (p, text) => {
      fs.mkdirSync(dirname2(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    exists: async (p) => fs.existsSync(p),
    stat,
    list: async (p) => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((d) => {
          const s = fs.lstatSync(join2(p, d.name));
          return { name: d.name, kind: kindOf(s), mtimeMs: s.isFile() ? s.mtimeMs : 0 };
        });
      } catch {
        return [];
      }
    },
    isExecutable: async (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    removeFiles: async (paths) => {
      for (const p of paths)
        fs.rmSync(p, { force: true });
    },
    removeDir: async (p) => {
      try {
        fs.rmdirSync(p);
      } catch {}
    },
    removeTree: async (p) => {
      fs.rmSync(p, { recursive: true, force: true });
    },
    run: (argv, options) => runProcess(argv, options),
    now: async () => Date.now(),
    progress: () => {
      return;
    },
    result: () => {
      return;
    },
    redraw: () => {
      return;
    },
    every: () => () => {
      return;
    }
  };
}
function runProcess(argv, options = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd)
      return resolve({ exitCode: 1, stdout: "", stderr: "", timedOut: false, error: "empty argv" });
    let child;
    try {
      const { CLAUDE_AGENT_ID: _inherited, ...inheritedEnv } = process.env;
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: { ...inheritedEnv, ...options.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (e) {
      return resolve({ exitCode: 1, stdout: "", stderr: "", timedOut: false, error: String(e) });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      resolve(r);
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid)
          process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish({ exitCode: 1, stdout, stderr, timedOut, error: e.message }));
    child.on("close", (code) => finish({ exitCode: timedOut ? 1 : code ?? 1, stdout, stderr, timedOut }));
    child.stdin?.on("error", () => {
      return;
    });
    child.stdin?.end(options.stdin ?? "");
  });
}

// src/cli.ts
var EVENTS2 = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop"];
var str2 = (v) => typeof v === "string" ? v : "";
function optionsFromEnv(env) {
  const opt = (key) => env[`CLAUDE_PLUGIN_OPTION_${key}`];
  return {
    language: opt("language"),
    agentLaunchGuard: opt("agentLaunchGuard") === "true",
    autoCount: opt("autoCount") !== "false",
    rulesFile: opt("rulesFile")
  };
}
async function runHook(event, payload, env) {
  const options = optionsFromEnv(env);
  const io = makeNodeIo({ env, payloadCwd: str2(payload.cwd), language: str2(options.language), autoCount: options.autoCount !== false });
  const sessionId = str2(payload.session_id) || "unknown";
  const run = {
    SessionStart: () => sessionStart(io, sessionId, payload),
    UserPromptSubmit: () => userPromptSubmit(io, sessionId, options),
    PreToolUse: () => preToolUse(io, sessionId, options, payload),
    PostToolUse: () => postToolUse(io, sessionId, payload),
    Notification: () => notification2(io, sessionId, payload),
    Stop: () => stop(io, sessionId, payload),
    SubagentStop: () => subagentStop(io, sessionId, payload)
  }[event];
  const { outcome, stderr } = await run();
  return outcomeToClassic(event, outcome, stderr);
}
async function main5() {
  const event = EVENTS2.find((e) => e === process.argv[2]);
  if (!event) {
    process.stderr.write(`usage: cli.js <${EVENTS2.join("|")}>
`);
    process.exit(1);
  }
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk));
  let payload = {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (isDict(v))
      payload = v;
  } catch {}
  try {
    const out = await runHook(event, payload, process.env);
    process.stdout.write(out.stdout);
    process.stderr.write(out.stderr);
    process.exitCode = out.exitCode;
  } catch {
    process.exitCode = 0;
  }
}
await main5();
export {
  optionsFromEnv,
  runHook
};
