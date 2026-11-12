# gate.yaml のフェーズと挙動

[← README](../../README_ja.md) · [English](../gate.md)

## session_start

<a id="session_start"></a>`gate.yaml` の 3 つめのフェーズ `session_start` は、SessionStart でコマンドを走らせ、その stdout をセッションの context（`additionalContext`）に足します（コードグラフの要約を渡す、など）。対象はメインのセッションだけで、payload に `agent_id` があれば何もしません。リセットの後に走ります。

```yaml
session_start:
  - name: depgraph
    cmd: "command -v depgraph >/dev/null || exit 0; depgraph hook session-start --format text"
    timeout: 10                        # 秒。既定は 10（300 ではない）
    on: [startup, resume, clear, compact]   # 省略可。既定はすべての source
    background: false                  # 省略可。true なら起動するだけで待たない
```

- `on` は SessionStart の payload の `source` で絞ります。source は `CLAUDE_SESSION_SOURCE` としてコマンドに渡されます。未知の値は一致しません。文字列だけの要素は `{cmd: ...}` の省略形です。
- 環境変数: `CLAUDE_PROJECT_DIR`、`CLAUDE_SESSION_ID`、`CLAUDE_SESSION_SOURCE`、`CLAUDE_GATE_FILES`（空）。`CLAUDE_AGENT_ID` は未設定です。
- コマンドは `max_parallel` を上限に並列で走ります。exit 0 で終わったコマンドの stdout が、宣言順に `[gate] session_start: <name>` の見出し付きで連結されます。出力が空なら何も足しません。出力は平文か SessionStart の hook JSON（オブジェクト）で、JSON のときは `hookSpecificOutput.additionalContext` だけを使います（空でない additionalContext が無い JSON は何も足さず、最上位の `systemMessage` はユーザーに表示します）。合計は 8 KiB（8192 文字）が上限で、切り詰めたときはその旨を添えます。
- 失敗やタイムアウトでセッションを止めることはありません。終了コードとログのパス（`.claude/.gate-status/logs/<session>/<name>.<id>.log`）を stderr に 1 回だけ知らせ、あわせて hook 出力の最上位 `systemMessage` にも載せ（exit 0 の hook の stderr は Claude Code に表示されないため）、hook の終了コードは 0 のまま、ほかのコマンドも走ります。`timeout` が 600 を超える場合は 600 に切り詰めます。SessionStart の hook 自体はフェーズ全体で最大 600 秒まで待ちます（`hooks/hooks.json` の `timeout: 600`）。
- `background: true` はコマンドを切り離して起動し、hook は待ちません（出力はログにだけ残り、context には入りません）。
- ポリシーも実行共有も使いません: 出力をいま必要とするので、dogwood による後回しも、エージェント間の共有もしません。読むのはプロジェクトルートの `gate.yaml` だけです。

## stop_review

<a id="stop_review"></a>作業の結果をモデル自身に確かめさせると精度が上がるので、停止の直前に「今回の変更を見直す」1 手を強制する設定です。既定は無効で、`gate.yaml` に書いたプロジェクトでだけ動きます。

```yaml
stop_review: true          # すべて既定値で有効
# または
stop_review:
  effort: xhigh            # low / medium / high / xhigh / max。既定 xhigh。false で effort は変えない
  match: ['src/**', '**/*.go']   # 対象にする変更ファイル（省略時はすべて）
  max_rounds: 1            # 見直し中の修正を続けて見直す回数の上限（既定 1、最大 5）
  subagents: true          # SubagentStop でも行う（既定 true）
  prompt: |                # 指示の末尾に足すプロジェクト固有の確認事項
    マイグレーションを足したら down も確認する。
```

- **いつ。** Stop / SubagentStop で、gate の `checks` フェーズと feedback の `stop_check` が通ったあと（どちらかが止めた回には出しません）。前回の見直し以降にそのセッション（サブエージェントならそのエージェント）が変更したファイルがあるときだけです。変更が無いターン（質問への回答など）では何もしません。
- **何を返すか。** 停止を 1 回ブロックし（`decision: block`）、理由として手順を返します: まず Skill ツールで `feedback-gate:effort-<effort>` を呼んでそのターンの残りの effort を切り替え、変更ファイルの差分と周辺を実物で読み直し、依頼を満たしているか・ロジックや境界条件・呼び出し側やテスト、ドキュメントの更新漏れ・不要な変更の残り・実際に動かしたかを確かめ、問題があれば直し、無ければ確かめた内容を 1〜3 行で報告して止まる、というものです。末尾に変更ファイルの一覧（30 件まで）と `prompt` が付きます。
- **effort の切り替え。** hook の出力にはセッションの effort を変える手段が無いので、同梱スキル（[`/feedback-gate:effort-<level>`](commands-and-skills.md#feedback-gateeffort-level)）の frontmatter `effort` を使います。効くのは見直しのターンの残りだけで、セッションの設定は変わりません。スキルを呼ぶのはモデルなので、呼ばなかった場合や、スキルの `effort` を扱わない環境（Codex など）では effort は変わらず、見直しだけが行われます。
- **変更ファイルの控え。** `changed_files` と同じタイミング（Edit / Write / MultiEdit と、Bash が書き換えたファイル）で `.claude/.gate-status/review_pending.<session>[--<agent>].txt` に足します。`changed_files` と違って gate が通っても消えず、見直しを出したときに消します。
- **繰り返さない。** 見直しの途中の修正も控えに足されるので、次の Stop でまた見直しになります。これを `max_rounds` 回（`review_rounds.<session>[--<agent>].txt`）で打ち切ります。既定の 1 では、見直しは 1 ターンに 1 回で、その修正は（gate と `stop_check` は通したうえで）見直さずに停止を通します。回数は、見直すものが無かった Stop と打ち切った Stop で 0 に戻ります。数えるのは hook のブロックで続いている間（`stop_hook_active`）だけなので、ターンが中断されて回数が残っても、次のターンの Stop は 1 回目から見直します。
- **上限。** `gate.yaml` はリポジトリの内容なので、信頼していないリポジトリが停止を際限なく止めたり、長い文面を流し込んだりできないようにしています: `max_rounds` は 5 まで（それを超える値は 5）、`prompt` は 2000 文字まで（超えた分は切り捨て）で、「プロジェクト固有の確認事項（gate.yaml の stop_review.prompt）」という見出しを付けて出します。変更ファイルのパスは 1 件 300 文字で切り、改行を含むパスは一覧に載せません。`match` の glob が不正なときは、すべての変更ファイルを対象にします。
- 状態ファイルは他と同じく SessionStart の `reset-gate`（`startup` / `clear`、または 24 時間超）が消します。見直しでブロックしたあと実際に止まった回には、`stop` 通知を出します。

## エージェント間の実行共有

複数のエージェント（メインとサブエージェント）が同時に同じコマンドを実行しようとしたとき、gate は実体を 1 回だけ起動します。「同じ」とは、root・cwd・`cmd`・コマンドに渡す環境変数がすべて一致することで、エージェント識別用の変数（`CLAUDE_AGENT_ID`）と対象ファイル一覧（`CLAUDE_GATE_FILES`）は比較から除きます。対象ファイル一覧はエージェントごとに違いうるので、別に扱います。後から来たエージェントは、同じ条件で進行中の実行のうち、その対象ファイルが自分の対象ファイルをすべて含むもの（自分の一覧が空ならどれでも）があれば、起動し直さず、その完了を待って同じ結果（終了コード・出力・タイムアウト）を受け取ります。受け取った側も自分で実行した場合と同じに扱います（自分の trace とログディレクトリに記録し、同じキーの控えを消化し、フェーズの成否に反映します）。完了済みの結果は再利用せず、重なった実行だけをまとめます。エージェントごとの hook が同じプロセスで動く保証はないため、調停は `.claude/.gate-status/shared/` 配下のファイル（コマンドと対象ファイル一覧の組ごとのロックディレクトリ）で行います。

受け取れる実行が無い場合（対象ファイルが含まれない、環境変数・root・cwd が違うなど）でも、同じコマンドは同時に 1 本しか走らせません。単位は `name`（無ければ `cmd`）で、同じものが別のエージェントで走っている間は起動せず、それが終わるのを待ってから、改めて受け取れる実行を探すか自分で実行します（待っている間は帯に `待機中` と出ます）。`go test ./...` のような重いコマンドをエージェントの数だけ同時に走らせると、CPU の取り合いで全員が何倍も遅くなるためです。異なるコマンドに同じ `name` を付けると、それらも 1 本ずつ走ります。同じリポジトリの別の git worktree で動くエージェントの間でも直列になります（ロックはリポジトリ（共通の git ディレクトリ）ごとの `~/.claude/.gate-status/shared/<project_id>/` に置きます。root・cwd が違うので、結果の受け取りは同じ worktree の中だけです）。ロックの生死はコマンドのプロセスで判定します。ESC などで hook が止められてロックが残っても、コマンドが終わっていれば次のエージェントがすぐに奪い直し、コマンドがまだ走っていればその終了を待ちます。コマンドの `timeout` を過ぎたロックも落ちたものとみなします。`share: false` のコマンドは共有も直列化もせず、常にすぐ自分で実行します。

多くのエージェントがほぼ同時に止まったときの待ちを短くする仕組みが 2 つあります。1 つ目は、同じ `name` の実行を待っているエージェントの対象ファイル一覧をまとめることです。待っている間、各エージェントは自分のキーと対象ファイル一覧を `<serial>.queue/` に置き、次にそのコマンドを起動するエージェントは、自分の対象ファイルと置かれた分の和集合で 1 回だけ走らせます（`CLAUDE_GATE_FILES` に和集合が渡ります）。待っていた側はその 1 回の結果を受け取るので、エージェントの数だけ順に走ることがなくなります。この実行は他のエージェントのファイルも対象に含むので、そのファイルでの失敗は受け取った全員の失敗になります（含む実行を受け取る場合と同じ扱いです）。2 つ目は `gate.yaml` のトップレベルの `max_parallel` で、プロジェクトの全エージェント・全 worktree で同時に走らせる gate コマンドの数の上限です（既定 `2`。`false` で無制限）。コマンドを起動するエージェントは先に共有ディレクトリ配下の `slot.<i>/` を 1 つ取り、空いていなければ空くのを待ちます（共有の結果を受け取るだけなら枠は要りません）。`parallel` ブロックの中や `share: false` のコマンドにも効きます。サブエージェント 10 体がプロジェクト全体のテストを走らせるような場面で、全員が CPU を取り合って何倍も遅くなり（タイムアウトし）続けるのを防ぎ、1 本ずつは単独で走らせたときに近い時間で終わるようにします:

```yaml
max_parallel: 2   # 既定。false で無制限
rules:
  - ...
```

共有（と直列化）したくないコマンドは、`run` 要素に `share: false` を書きます（`{cmd, name, timeout, share, files}`）。

```yaml
run:
  - { cmd: "bun test", name: test, share: false }
```

対象ファイルを使わないコマンド（`go test ./...` のようにファイル一覧に関係なく全体を走らせるもの）は、`files: false` を書くと、共有の判定上の対象ファイルを空として扱い、エージェントごとに対象ファイルが違っても共有されます。`CLAUDE_GATE_FILES` 自体は従来どおりコマンドに渡ります。`share: false` と併記した場合は `share: false` が優先され、共有しません。

```yaml
run:
  - cmd: go test ./...
    name: test
    files: false
```

## 直していない失敗

`rules` フェーズ（PostToolUse）でルールが失敗しても、ターンは止まらず、結果が Claude へのフィードバックとして返るだけです。トランスクリプトを圧迫しないよう、このフィードバックにはコマンドの出力を載せません。コマンドごとの 1 行（`[gate] ok: ...` / `[gate] fail: ...`）と、失敗したコマンドについては見出し・（あれば）タイムアウトの文言・ログのパス（`[gate] log: .claude/.gate-status/logs/<state>/<name>.<id>.log`）だけを返し、そのログを開いてエラーを直すよう促します。出力の全文はそのログにだけ残り、ログは従来どおりの掃除で消えます（現セッションのログは 1 時間、他セッションのログは最終書き込みから 5 分で削除）。`checks` フェーズ（Stop / SubagentStop）も同じで、ブロック理由には失敗したコマンドとログのパスだけを載せ、出力は載せません。ただし失敗したファイルを `.claude/.gate-status/gate_failed.<state>.txt` に控え、次の `checks` フェーズ（Stop / SubagentStop）で、まずそのルールを最新の内容で再実行します。まだ失敗なら、consistency check の失敗と同じく停止をブロックします（成功報告も出しません）。通れば、`rules` フェーズで通ったときと同じ扱いになります。そのため、lint の失敗を直さずにターンを終えることはできません。連続して `MAX_ATTEMPTS`（5）回ブロックしたら諦め、控えを消します（ファイルは変更ファイルの一覧に残るので、次の編集で再び検査されます）。

## 成功報告

checks フェーズ（Stop / SubagentStop）で 1 件以上のコマンドが実際に実行され、すべて成功したとき、gate は Stop を 1 回だけブロックして結果の要約を reason として返します（例: `[gate] 検証がすべて通りました: lint ✓ / typecheck ✓ / test ✓。この結果をユーザーに報告して終了してください。`）。エージェントはこれを受けて、ユーザーが「通ってそう」と伝えなくても完了報告して止まれます。報告でブロックした直後の Stop（`stop_hook_active`）では gate のコマンドを一切実行せず通します。何も実行されなかったとき、`stop_hook_active` が true のとき（失敗ブロックの続き）、`{.claude,.agents}/gate.yaml` のトップレベルに `report_success: false` を書いたとき（既定は有効）は報告しません。失敗時のブロックは従来どおりです。
