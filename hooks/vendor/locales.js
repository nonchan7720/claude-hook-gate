export const en_default = `# Messages printed by the hooks (English). Has the same keys as ja.yaml (tests/i18n.spec.ts checks the key sets match).
# {{name}} is i18next interpolation.
notify:
  waiting: "Waiting for you"
  waitingFallback: "Claude is waiting for your input"
  done: "Done"
  doneFallback: "The response has finished"

inject:
  header: "# Confirmed feedback rules (count >= 3)\\nThese rules were pointed out repeatedly and are confirmed. A hook blocks violations.\\n\\n"
  ruleTitle: "■ {{name}} (pointed out {{count}} times so far)"
  fileHeaderRead: "# Feedback rules for {{files}}\\nThese confirmed rules apply to the file you just read. Follow them when you edit it or write files like it. A hook blocks violations.\\n\\n"
  fileHeaderEdit: "# Feedback rules for {{files}}\\nThese confirmed rules apply to the file you just edited. Check that edit against them and follow them in the edits that follow. A hook blocks violations.\\n\\n"
  brokenRules: "# Unreadable feedback rules\\nThe following rule files could not be read and are disabled (where only an enforce entry is invalid, only that entry is disabled). Their enforcement does not work until they are fixed. Tell the user:"

rules:
  unreadable: "cannot read the file: {{error}}"
  enforceNotList: "enforce is not a list ({{type}}). Write each entry as \`- event: ...\`"
  enforceItemNotMapping: "enforce[{{index}}] is not a mapping ({{type}})"
  badRegex: "enforce[{{index}}].{{key}} is not a usable regular expression: {{error}}"
  evalError: "enforce[{{index}}] failed to evaluate: {{error}}"

guard:
  evaluating: "[feedback-guard] evaluating: {{rule}}"

newRule:
  header: "[feedback-gate] Before creating the new rule {{file}}, check the existing rules (★ = similar name / description, {{n}} found):"
  more: "…and {{n}} more"
  instruction: "If a rule already covers the same feedback or kind of situation, do not create a new file; update that rule: raise its count by 1 (unless a hook already did in this session), add this case and the excuse to the body, and generalize the wording. If several rules are close, propose merging them. Only when none fits, run the same write again (it is not stopped the second time)."

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

codex:
  askAsDeny: "[feedback-gate] Codex has no ask in PreToolUse, so this rule denied the call. Read the reason above and fix the call; the same rule on the same target is only warned about from the next call in this session."

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
  restOmitted: "… (rest omitted)"
  failuresOmitted: "… ({{n}} more failures omitted; see the [gate] log path of each)"
  policyNotFound: "=== [gate] The policy file was not found: {{policy}}. Running without policy evaluation. ==="
  sharedResult: "[gate] The same run was in progress in another agent, so its result was taken over (log of the running side: {{logpath}})"
  timeout: "[gate] Killed after the timeout ({{seconds}}s). The command may be in an infinite loop or hung."
  failedOutputHeader: "--- failed commands (the output is in each log file) ---"
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
  rulesFailed: "[gate] Verification failed. Stopping (and reporting the work as done) is blocked until it is fixed. The command output is not shown here: open the log file of each failed command (the [gate] log: path above), find the errors and fix them now."
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
  checksFailed: "[gate] Verification failed (attempt {{attempt}}/{{max}}). The command output is not shown here: open the log file of each failed command (the [gate] log: path) to find the errors, and keep fixing."
  ymlTypo: "[gate] gate.yaml was not found but {{path}} exists. Check whether the extension is yml instead of yaml."
  policyUnevaluated: "=== [gate] ({{label}}) Skipped this time because the policy could not be evaluated (intentional throttling; no need to investigate. Queued, so it runs automatically later) [{{reason}}] $ {{cmd}} ==="
  policySkipped: "=== [gate] ({{label}}) Skipped this time by policy (intentional throttling; no need to investigate. Queued, so it runs automatically later) $ {{cmd}} ==="
  notePolicySkipped: "(deferred by the policy verdict; queued to run automatically later)"
  notePolicyUnevaluated: "(deferred because the policy could not be evaluated; queued to run automatically later: {{reason}})"
  internalError: "[gate] An internal error occurred, so the checks were skipped (work continues). See stderr for details."
  sessionStartHeader: "[gate] session_start: {{name}}"
  sessionStartTruncated: "[gate] session_start output was truncated (limit: {{limit}} characters)."
  sessionStartExit: "exit status {{code}}"
  sessionStartTimeout: "timed out after {{seconds}}s"
  sessionStartFailed: "[gate] session_start: {{name}} failed ({{reason}}). Log: {{logpath}}"
`;
export const ja_default = `# hook が出すメッセージ（日本語）。en.yaml と同じキーを持つ（tests/i18n.spec.ts がキーの一致を検査する）。
# {{name}} は i18next の補間。
notify:
  waiting: "確認待ち"
  waitingFallback: "確認を待っています"
  done: "完了"
  doneFallback: "応答が完了しました"

inject:
  header: "# 確定フィードバックルール（count >= 3）\\nこれらは繰り返し指摘された確定ルール。違反すると hook がブロックする。\\n\\n"
  ruleTitle: "■ {{name}} (これまで {{count}} 回指摘されています)"
  fileHeaderRead: "# {{files}} に適用されるフィードバックルール\\n今読んだファイルに適用される確定ルール。このファイルや同種のファイルを書くときに従うこと。違反すると hook がブロックする。\\n\\n"
  fileHeaderEdit: "# {{files}} に適用されるフィードバックルール\\n今編集したファイルに適用される確定ルール。今回の編集をこれに照らして確かめ、以降の編集でも従うこと。違反すると hook がブロックする。\\n\\n"
  brokenRules: "# 読めない feedback ルール\\n次のルールファイルが読めず無効になっています（enforce の要素だけが不正なものは、その要素だけが無効）。直すまで、その強制は効きません。ユーザーに伝えてください:"

rules:
  unreadable: "ファイルを読めません: {{error}}"
  enforceNotList: "enforce がリストではありません（{{type}}）。各要素を \`- event: ...\` の形で書いてください"
  enforceItemNotMapping: "enforce[{{index}}] が辞書ではありません（{{type}}）"
  badRegex: "enforce[{{index}}].{{key}} の正規表現が使えません: {{error}}"
  evalError: "enforce[{{index}}] の評価に失敗しました: {{error}}"

guard:
  evaluating: "[feedback-guard] 評価中: {{rule}}"

newRule:
  header: "[feedback-gate] 新しいルール {{file}} を作る前に既存のルールを確認してください（★ = name / description が似ているもの {{n}} 件）:"
  more: "…ほか {{n}} 件"
  instruction: "同じ指摘・同じ種類の状況を扱うルールがあれば、新しいファイルは作らずそのルールを更新すること: count を 1 上げ（このセッションで hook が上げ済みなら上げない）、本文に今回のケースと言い訳を足して一般化する。近いルールが複数あればまとめる提案をする。どれにも当てはまらないときだけ、同じ書き込みをもう一度実行する（2 回目は止めない）。"

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

codex:
  askAsDeny: "[feedback-gate] Codex の PreToolUse には ask が無いので、このルールは呼び出しを拒否しました。上の理由を読んで呼び出しを直してください。同じセッション・同じ対象への同じルールは、次の呼び出しからは warn になります。"

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
  restOmitted: "…（以降省略）"
  failuresOmitted: "…（残り {{n}} 件の失敗は省略。各 [gate] log のパスを見てください）"
  policyNotFound: "=== [gate] policy に指定されたファイルが見つかりません: {{policy}}。ポリシー判定を行わず実行します。 ==="
  sharedResult: "[gate] 同じ実行が他のエージェントで走っていたため、その結果を受け取りました（実行側のログ: {{logpath}}）"
  timeout: "[gate] タイムアウト（{{seconds}}秒）で強制終了しました。無限ループやハングの可能性があります。"
  failedOutputHeader: "--- 失敗したコマンド（出力は各ログファイルにあります） ---"
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
  rulesFailed: "[gate] 検証に失敗しました。直すまで終了（Stop）はブロックされ、完了報告もできません。コマンドの出力はここには載せていません。失敗したコマンドのログファイル（上の [gate] log: のパス）を開いてエラーを確認し、今ここで修正してください。"
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
  checksFailed: "[gate] 検証に失敗しました（試行 {{attempt}}/{{max}}）。コマンドの出力はここには載せていません。失敗したコマンドのログファイル（[gate] log: のパス）を開いてエラーを確認し、修正を継続してください。"
  ymlTypo: "[gate] gate.yaml が見つかりませんが {{path}} があります。拡張子が yaml ではなく yml になっていないか確認してください。"
  policyUnevaluated: "=== [gate] ({{label}}) ポリシーを評価できないため今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）［{{reason}}］ $ {{cmd}} ==="
  policySkipped: "=== [gate] ({{label}}) ポリシーにより今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます） $ {{cmd}} ==="
  notePolicySkipped: "(ポリシー判定で見送り。控えに積んだので後で自動実行)"
  notePolicyUnevaluated: "(ポリシーを評価できず見送り。控えに積んだので後で自動実行: {{reason}})"
  internalError: "[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。"
  sessionStartHeader: "[gate] session_start: {{name}}"
  sessionStartTruncated: "[gate] session_start の出力が長すぎたため途中で切り詰めました（上限 {{limit}} 文字）。"
  sessionStartExit: "終了コード {{code}}"
  sessionStartTimeout: "{{seconds}} 秒でタイムアウト"
  sessionStartFailed: "[gate] session_start: {{name}} が失敗しました（{{reason}}）。ログ: {{logpath}}"
`;
