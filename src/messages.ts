// hook が出すメッセージの日本語版と英語版。どの言語で出すかは i18n.ts の resolveLang が決め、各モジュールは
// `tr(io.lang)` で引いた関数にここのメッセージを渡す。引数付きのメッセージは関数で、ja / en の引数は同じ型。
import { msg } from './i18n.ts'

// ---- notification ----
export const NOTIFY_WAITING = msg(
  () => '確認待ち',
  () => 'Waiting for you',
)
export const NOTIFY_WAITING_FALLBACK = msg(
  () => '確認を待っています',
  () => 'Claude is waiting for your input',
)
export const NOTIFY_DONE = msg(
  () => '完了',
  () => 'Done',
)
export const NOTIFY_DONE_FALLBACK = msg(
  () => '応答が完了しました',
  () => 'The response has finished',
)

// ---- feedback-inject ----
export const INJECT_HEADER = msg(
  () => '# 確定フィードバックルール（count >= 3）\nこれらは繰り返し指摘された確定ルール。違反すると hook がブロックする。\n\n',
  () => '# Confirmed feedback rules (count >= 3)\nThese rules were pointed out repeatedly and are confirmed. A hook blocks violations.\n\n',
)
export const INJECT_RULE_TITLE = msg(
  (name: string, count: number) => `■ ${name} (これまで ${count} 回指摘されています)`,
  (name: string, count: number) => `■ ${name} (pointed out ${count} times so far)`,
)

// ---- feedback-rules（評価中の表示） ----
export const GUARD_EVALUATING = msg(
  (rule: string) => `[feedback-guard] 評価中: ${rule}`,
  (rule: string) => `[feedback-guard] evaluating: ${rule}`,
)
export const POST_EDIT_CHECKING = msg(
  (rule: string, file: string) => `[feedback-post-edit] 検査中: ${rule} (${file})`,
  (rule: string, file: string) => `[feedback-post-edit] checking: ${rule} (${file})`,
)
export const STOP_CHECK_CHECKING = msg(
  (rule: string, file: string) => `[feedback-stop-check] 検査中: ${rule} (${file})`,
  (rule: string, file: string) => `[feedback-stop-check] checking: ${rule} (${file})`,
)

// ---- feedback-stop-check ----
export const STOP_CHECK_GAVE_UP = msg(
  (max: number) => `[feedback-stop-check] ${max} 回連続でブロックしました。ループを打ち切ります。手動確認を。`,
  (max: number) => `[feedback-stop-check] Blocked ${max} times in a row. Giving up the loop; please check manually.`,
)
export const STOP_CHECK_FIX_ABOVE = msg(
  (attempt: number, max: number) => `[feedback-stop-check] 上記を修正してください（試行 ${attempt}/${max}）。`,
  (attempt: number, max: number) => `[feedback-stop-check] Fix the above (attempt ${attempt}/${max}).`,
)

// ---- agent-launch-guard ----
export const LAUNCH_CHECKLIST = msg(
  () => '--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件',
  () => '--- Check: what to do / background / current state of the code / what not to do / done criteria',
)
export const LAUNCH_PROMPT_TO = msg(
  (agentType: string) => `${agentType} に送るプロンプト:`,
  (agentType: string) => `Prompt to send to ${agentType}:`,
)
export const LAUNCH_MESSAGE_TO = msg(
  (recipient: string) => `${recipient} に送るメッセージ:`,
  (recipient: string) => `Message to send to ${recipient}:`,
)
export const LAUNCH_UNKNOWN_RECIPIENT = msg(
  () => '宛先不明',
  () => 'unknown recipient',
)

// ---- /correct ----
export const CORRECT_DESCRIPTION = msg(
  () => 'feedback ルールと違反ログを集計し、count の引き上げや enforce の追加を提案する',
  () => 'Aggregate the feedback rules and the violation log, and propose count bumps and enforce additions',
)
export const CORRECT_ENFORCE_TEMPLATE = msg(
  () => `enforce:
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
    message: '違反時に出す指示文'`,
  () => `enforce:
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
    message: 'instruction shown on violation'`,
)
export const CORRECT_EXPIRED = msg(
  (date: string) => `expires（${date}）を過ぎている`,
  (date: string) => `expires (${date}) has passed`,
)
export const CORRECT_CONDITIONS = msg(
  () => '条件',
  () => 'the conditions',
)
export const CORRECT_NOT_MATCHING = msg(
  (what: string) => `${what} がこのプロジェクトに一致せず無効`,
  (what: string) => `${what} do not match this project, so the rule is inactive`,
)
export const CORRECT_TOP_DETAIL = msg(
  (detail: string) => `。最多: ${detail}`,
  (detail: string) => `. Most frequent: ${detail}`,
)
export const CORRECT_BUMP_TO_CONFIRMED = msg(
  (window: string, n: number, counts: string, top: string) => `直近 ${window} で ${n} 回違反（${counts}）。確定ルールへ昇格${top}`,
  (window: string, n: number, counts: string, top: string) => `${n} violations in the last ${window} (${counts}). Promote to a confirmed rule${top}`,
)
export const CORRECT_BUMP_TO_DENY = msg(
  (window: string, strong: number, counts: string, top: string) => `直近 ${window} で ask / block が ${strong} 回（${counts}）。deny へ引き上げ${top}`,
  (window: string, strong: number, counts: string, top: string) => `ask / block ${strong} times in the last ${window} (${counts}). Raise to deny${top}`,
)
export const CORRECT_NO_ENFORCE = msg(
  (count: number) => `count ${count} の確定ルールだが enforce が無く、hook が検知できない（違反ログにも出ない）`,
  (count: number) => `Confirmed rule with count ${count} but no enforce, so no hook can detect it (and it never appears in the violation log)`,
)
export const CORRECT_STALE = msg(
  () => 'enforce ありで違反ログに一度も出ていない。enforce が効いているか、ルールが古くなっていないか確認',
  () => 'Has enforce but has never appeared in the violation log. Check that the enforce works and that the rule is not out of date',
)
export const CORRECT_EXPIRED_ACTION = msg(
  (reason: string) => `${reason}。削除または更新を検討`,
  (reason: string) => `${reason}. Consider deleting or updating it`,
)
export const CORRECT_REPORT_HEADER = msg(
  (window: string, rules: number, violations: number) => `[correct] 直近 ${window}: ルール ${rules} 件 / 違反 ${violations} 件`,
  (window: string, rules: number, violations: number) => `[correct] last ${window}: ${rules} rules / ${violations} violations`,
)
export const CORRECT_NO_PROPOSALS = msg(
  () => '提案はありません。',
  () => 'No proposals.',
)
export const CORRECT_APPLY_NONE = msg(
  () => 'apply: 書き換えたファイルはありません。',
  () => 'apply: no files were rewritten.',
)
export const CORRECT_APPLY_DONE = msg(
  () => 'apply: count を書き換えました。',
  () => 'apply: count was rewritten.',
)
export const CORRECT_APPLY_HINT = msg(
  () => '`/correct apply` で bump の count 引き上げをファイルに書き込みます（enforce は提案のみ）。',
  () => '`/correct apply` writes the count bumps of the bump proposals to the files (enforce is proposal only).',
)
export const CORRECT_CONTEXT = msg(
  () =>
    [
      '/correct の結果です。ユーザーに上記の提案を提示してください。',
      '- enforce の追加は、対象ルールの本文から正規表現 / glob を起こして具体案を提案する（雛形は rules/feedback_rules.md の enforce 節）。',
      '- ファイルを書き換える前に、必ずユーザーに確認する（rules/feedback_rules.md のルールどおり）。',
      '- stale / expired は、ルールを残すか更新・削除するかをユーザーに尋ねる。',
    ].join('\n'),
  () =>
    [
      'This is the result of /correct. Present the proposals above to the user.',
      '- For an enforce addition, derive a regex / glob from the body of the rule and propose a concrete entry (template: the enforce section of rules/feedback_rules.md).',
      '- Always ask the user before rewriting any file (as the rules in rules/feedback_rules.md say).',
      '- For stale / expired, ask the user whether to keep, update or delete the rule.',
    ].join('\n'),
)
export const CORRECT_CONTEXT_APPLIED = msg(
  (list: string) => `- apply により次のファイルの count をすでに書き換えた。その事実をユーザーに伝えること: ${list}`,
  (list: string) => `- apply has already rewritten count in the following files. Tell the user so: ${list}`,
)

// ---- running-registry（帯とステータス行） ----
export const BAND_RUNNING = msg(
  () => '[gate] 実行中:',
  () => '[gate] running:',
)
export const BAND_WAITING = msg(
  () => '待機中',
  () => 'waiting',
)
export const BAND_DONE = msg(
  (counts: string, seconds: string) => `[gate] 完了: ${counts} (${seconds}s)`,
  (counts: string, seconds: string) => `[gate] done: ${counts} (${seconds}s)`,
)

// ---- gate ----
export const GATE_HEAD_OMITTED = msg(
  (n: number) => `…（先頭 ${n} 行省略）`,
  (n: number) => `… (first ${n} lines omitted)`,
)
export const GATE_REST_OMITTED = msg(
  () => '…（以降省略）',
  () => '… (rest omitted)',
)
export const GATE_FAILURES_OMITTED = msg(
  (n: number) => `…（残り ${n} 件の失敗は省略。各 [gate] log のパスを見てください）`,
  (n: number) => `… (${n} more failures omitted; see the [gate] log path of each)`,
)
export const GATE_POLICY_NOT_FOUND = msg(
  (policy: string) => `=== [gate] policy に指定されたファイルが見つかりません: ${policy}。ポリシー判定を行わず実行します。 ===`,
  (policy: string) => `=== [gate] The policy file was not found: ${policy}. Running without policy evaluation. ===`,
)
export const DOGWOOD_NOT_FOUND = msg(
  () => 'dogwood バイナリが見つかりません（DOGWOOD_BIN / PATH / ~/.cargo/bin を確認してください）',
  () => 'dogwood binary not found (check DOGWOOD_BIN / PATH / ~/.cargo/bin)',
)
export const DOGWOOD_RUN_FAILED = msg(
  (error: string) => `dogwood の実行に失敗しました: ${error}`,
  (error: string) => `failed to run dogwood: ${error}`,
)
export const DOGWOOD_EXITED = msg(
  (code: number, detail: string) => `dogwood replay が異常終了しました（exit ${code}）: ${detail}`,
  (code: number, detail: string) => `dogwood replay exited abnormally (exit ${code}): ${detail}`,
)
export const DOGWOOD_BAD_JSON = msg(
  () => 'dogwood replay の出力を JSON として読めませんでした',
  () => 'could not parse the output of dogwood replay as JSON',
)
export const DOGWOOD_NO_VERDICT = msg(
  () => 'dogwood replay が verdict を返しませんでした',
  () => 'dogwood replay returned no verdict',
)
export const DOGWOOD_BAD_VERDICT = msg(
  (verdict: string) => `dogwood replay の verdict を解釈できませんでした: ${verdict}`,
  (verdict: string) => `could not interpret the verdict of dogwood replay: ${verdict}`,
)
export const GATE_SHARED_RESULT = msg(
  (logpath: string) => `[gate] 同じ実行が他のエージェントで走っていたため、その結果を受け取りました（実行側のログ: ${logpath}）`,
  (logpath: string) => `[gate] The same run was in progress in another agent, so its result was taken over (log of the running side: ${logpath})`,
)
export const GATE_TIMEOUT = msg(
  (seconds: number) => `[gate] タイムアウト（${seconds}秒）で強制終了しました。無限ループやハングの可能性があります。`,
  (seconds: number) => `[gate] Killed after the timeout (${seconds}s). The command may be in an infinite loop or hung.`,
)
export const GATE_FAILED_OUTPUT_HEADER = msg(
  () => '--- 失敗したコマンドの出力 ---',
  () => '--- output of the failed commands ---',
)
export const GATE_NESTED_PARALLEL = msg(
  (label: string) => `=== [gate] (${label}) parallel の中に parallel はネストできません。失敗扱いにします。 ===`,
  (label: string) => `=== [gate] (${label}) parallel cannot be nested inside parallel. Treated as a failure. ===`,
)
export const GATE_DEFERRED_NO_CWD = msg(
  (label: string, cwd: string) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。この控えを破棄します。 ===`,
  (label: string, cwd: string) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Dropping this deferred entry. ===`,
)
export const GATE_CANNOT_READ_YAML = msg(
  (path: string) => `gate.yaml を読めません: ${path}`,
  (path: string) => `cannot read gate.yaml: ${path}`,
)
export const GATE_AND_MORE = msg(
  (n: number) => ` ほか${n}件`,
  (n: number) => ` and ${n} more`,
)
export const GATE_SKIP_UNMATCHED = msg(
  (files: string) => `[gate] skip: ${files} (どのルールにもマッチしません)`,
  (files: string) => `[gate] skip: ${files} (matches no rule)`,
)
export const GATE_BAD_PER_FILE_DIR = msg(
  (value: string) =>
    `=== [gate] per_file_dir の値が不正です: ${value}（true / "file" / "pattern_root" のいずれかを指定してください）。このルールをスキップします。 ===`,
  (value: string) => `=== [gate] Invalid per_file_dir value: ${value} (use true / "file" / "pattern_root"). Skipping this rule. ===`,
)
export const GATE_SKIP_BAD_PER_FILE_DIR = msg(
  () => '[skip: per_file_dir不正]',
  () => '[skip: invalid per_file_dir]',
)
export const GATE_ROOT_NO_CWD = msg(
  (label: string, cwd: string) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。このルートをスキップします。 ===`,
  (label: string, cwd: string) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Skipping this root. ===`,
)
export const GATE_RULE_NO_CWD = msg(
  (label: string, cwd: string) => `=== [gate] (${label}) cwd が存在しません: ${cwd}。このルールをスキップします。 ===`,
  (label: string, cwd: string) => `=== [gate] (${label}) cwd does not exist: ${cwd}. Skipping this rule. ===`,
)
export const GATE_CHECK_NO_CWD = msg(
  (name: string, cwd: string) => `=== [gate] (check:${name}) cwd が存在しません: ${cwd}。このチェックをスキップします。 ===`,
  (name: string, cwd: string) => `=== [gate] (check:${name}) cwd does not exist: ${cwd}. Skipping this check. ===`,
)
export const GATE_SKIP_NO_CWD = msg(
  () => '[skip: cwd無し]',
  () => '[skip: no cwd]',
)
export const GATE_NOTE_NO_CWD = msg(
  () => '(cwd が存在しません)',
  () => '(cwd does not exist)',
)
export const GATE_WORKTREE_NOT_FOUND = msg(
  (root: string) => `=== [gate] worktree が見つかりません: ${root}。対象から外します。 ===`,
  (root: string) => `=== [gate] worktree not found: ${root}. Excluding it. ===`,
)
export const GATE_RULES_FAILED = msg(
  () => '[gate] rules フェーズの検証に失敗しました（会話は止まりません）。上のエラーを見て修正してください。',
  () => '[gate] The rules phase failed (the conversation is not stopped). See the errors above and fix them.',
)
export const GATE_RULES_PASSED = msg(
  (body: string) => `[gate] rules フェーズ成功:\n${body}`,
  (body: string) => `[gate] rules phase passed:\n${body}`,
)
export const GATE_CHECK_NOT_FOUND = msg(
  (name: string) => `=== [gate] consistency_checks に "${name}" が見つかりません。スキップします。 ===`,
  (name: string) => `=== [gate] "${name}" was not found in consistency_checks. Skipping. ===`,
)
export const GATE_CHECK_NOT_FOUND_SUMMARY = msg(
  (name: string) => `(check:${name}) 見つかりません、スキップ`,
  (name: string) => `(check:${name}) not found, skipped`,
)
export const GATE_SKIP_CHECK_UNDEFINED = msg(
  (name: string) => `[gate] skip: check:${name} (consistency_checks に定義がありません)`,
  (name: string) => `[gate] skip: check:${name} (not defined in consistency_checks)`,
)
export const GATE_NOTHING_TO_RUN = msg(
  () => '（対象なし）',
  () => '(nothing to run)',
)
export const GATE_ALL_PASSED = msg(
  (labels: string) => `[gate] 検証がすべて通りました: ${labels}。この結果をユーザーに報告して終了してください。`,
  (labels: string) => `[gate] All checks passed: ${labels}. Report this result to the user and finish.`,
)
export const GATE_DEFERRED_TITLE = msg(
  () => '後回しにした検証コマンド',
  () => 'deferred verification commands',
)
export const GATE_CHECKS_PASSED = msg(
  (title: string, body: string) => `[gate] ${title} 成功:\n${body}`,
  (title: string, body: string) => `[gate] ${title} passed:\n${body}`,
)
export const GATE_CHECKS_GAVE_UP_STDERR = msg(
  (max: number) => `consistency checks が ${max} 回連続失敗。ループを打ち切ります。手動確認を。`,
  (max: number) => `consistency checks failed ${max} times in a row. Giving up the loop; please check manually.`,
)
export const GATE_CHECKS_GAVE_UP = msg(
  (max: number) =>
    `[gate] consistency checks が${max}回連続で失敗したため打ち切りました。` +
    '対象ファイルは未検証のまま CHANGED へ戻しました。' +
    '手動で確認してください。今すぐ解除したい場合は新しいセッションを開始するか ' +
    '/clear を実行してください（SessionStart の reset-gate が状態ファイルを削除します）。',
  (max: number) =>
    `[gate] Gave up because consistency checks failed ${max} times in a row. ` +
    'The target files were returned to CHANGED unverified. ' +
    'Please check them manually. To clear this now, start a new session or ' +
    'run /clear (reset-gate on SessionStart removes the state files).',
)
export const GATE_CHECKS_FAILED = msg(
  (attempt: number, max: number) => `consistency checks 失敗（試行 ${attempt}/${max}）。上のエラーを見て修正を継続してください。`,
  (attempt: number, max: number) => `consistency checks failed (attempt ${attempt}/${max}). See the errors above and keep fixing.`,
)
export const GATE_YML_TYPO = msg(
  () => '[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。拡張子が yaml ではなく yml になっていないか確認してください。',
  () => '[gate] .claude/gate.yaml was not found but .claude/gate.yml exists. Check whether the extension is yml instead of yaml.',
)
export const GATE_POLICY_UNEVALUATED = msg(
  (label: string, reason: string, cmd: string) =>
    `=== [gate] (${label}) ポリシーを評価できないため今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）［${reason}］ $ ${cmd} ===`,
  (label: string, reason: string, cmd: string) =>
    `=== [gate] (${label}) Skipped this time because the policy could not be evaluated (intentional throttling; no need to investigate. Queued, so it runs automatically later) [${reason}] $ ${cmd} ===`,
)
export const GATE_POLICY_SKIPPED = msg(
  (label: string, cmd: string) =>
    `=== [gate] (${label}) ポリシーにより今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます） $ ${cmd} ===`,
  (label: string, cmd: string) =>
    `=== [gate] (${label}) Skipped this time by policy (intentional throttling; no need to investigate. Queued, so it runs automatically later) $ ${cmd} ===`,
)
export const GATE_NOTE_POLICY_SKIPPED = msg(
  () => '(ポリシー判定で見送り。控えに積んだので後で自動実行)',
  () => '(deferred by the policy verdict; queued to run automatically later)',
)
export const GATE_NOTE_POLICY_UNEVALUATED = msg(
  (reason: string) => `(ポリシーを評価できず見送り。控えに積んだので後で自動実行: ${reason})`,
  (reason: string) => `(deferred because the policy could not be evaluated; queued to run automatically later: ${reason})`,
)
export const GATE_INTERNAL_ERROR = msg(
  () => '[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。',
  () => '[gate] An internal error occurred, so the checks were skipped (work continues). See stderr for details.',
)
