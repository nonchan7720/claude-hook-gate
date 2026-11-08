var e=`# hook が出すメッセージ（日本語）。en.yaml と同じキーを持つ（tests/i18n.spec.ts がキーの一致を検査する）。
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

hookList:
  description: "このプロジェクトで動く hook（gate.yaml のルールと feedback ルール）と、いつ・何を動かすかをブラウザで一覧表示する"
  title: "feedback-gate の hook 一覧"
  generated: "{{time}} 時点"
  opened: "[hook-list] ブラウザで開きました: {{path}}"
  openFailed: "[hook-list] ブラウザを開けませんでした。次のファイルをブラウザで開いてください: {{path}}"
  written: "[hook-list] 一覧を書き出しました。ブラウザで開いてください: {{path}}"
  filter: "名前・コマンド・glob で絞り込み"
  none: "（なし）"
  "on": "有効"
  "off": "無効"
  parallel: "並列"
  settings: "設定"
  gateMissing: "gate.yaml がありません（.claude/gate.yaml か .agents/gate.yaml を置くと品質ゲートが動きます）。"
  gateUnreadable: "YAML として読めないため、ゲートは動きません: {{reason}}"
  gateRules: "rules"
  gateRulesWhen: "ファイルを編集した直後（Edit / Write / MultiEdit / Bash）。変更ファイルが match にマッチしたルールをすべて実行。失敗しても止めず、停止時に直っていなければ再実行する。"
  runChecksNote: "マッチしたら停止時の consistency_checks に予約"
  gateChecks: "consistency_checks"
  gateChecksWhen: "停止時。このセッションでマッチした rule の run_checks に名前があるものだけ実行。失敗すると停止をブロックする。"
  unreferenced: "どの rule の run_checks にも無いので実行されない"
  gateSessionStart: "session_start"
  gateSessionStartWhen: "セッション開始時（メインのセッションのみ）。exit 0 のコマンドの stdout を context に足す。"
  gateSettings: "全体の設定"
  feedbackHeader: "feedback ルール"
  active: "有効なルール"
  inactive: "無効"
  broken: "読めない"
  scope:
    global: "グローバル"
    project: "プロジェクト"
  level:
    provisional: "暫定"
    confirmed: "確定"
    deny: "deny"
  levelNote:
    provisional: "count 1〜2: context には注入しない。enforce は warn。"
    confirmed: "count 3〜4: context に注入する。enforce は ask / block。"
    deny: "count 5 以上: context に注入する。enforce は deny / block。"
  colName: "名前"
  colScope: "置き場所"
  colLevel: "count · 段階"
  colInject: "注入"
  colEnforce: "enforce"
  filterLevel: "段階"
  filterScope: "置き場所"
  filterEvent: "イベント"
  injectShortPrompt: "毎プロンプト"
  injectShortNone: "しない"
  enforceNone: "なし"
  inject: "注入"
  injectNone: "しない（count < 3）"
  injectEveryPrompt: "毎プロンプト（UserPromptSubmit）"
  injectFiles: "{{globs}} に一致するファイルを読んだ・編集したとき{{exclude}}"
  injectExclude: "（{{globs}} を除く）"
  noEnforce: "なし（hook は検知しない）"
  event:
    pre_bash: "Bash の実行前にコマンド文字列を検査"
    pre_edit: "Edit / Write の前に書き込む内容を検査"
    post_edit: "編集の後にファイル全体を検査"
    stop_check: "停止時にセッション中の変更ファイルを検査"
  inactiveHeader: "無効なルール"
  brokenHeader: "読めないルール（/correct で直し方を提案）"
  optionsHeader: "プラグイン設定"
  agentLaunchGuard: "サブエージェントへ指示を送る前に本文を見せて確認する"
  autoCount: "違反したら count を自動で 1 上げる"
  language: "メッセージの言語"
`;var c=e;export{c as default};
