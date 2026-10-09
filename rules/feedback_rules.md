# グローバルルール

## フィードバック管理ルール

- ユーザーからフィードバック・指摘・訂正・好みを受けたら、**返答する前に必ず** `~/.claude/feedback/`, `.claude/feedback/` に Markdown ファイルとして保存すること。保存を忘れると次の会話で同じ指摘を繰り返させることになる。

### 作業前

- `~/.claude/feedback/`
  - グローバルルール
- `.claude/feedback/`
  - プロジェクト固有ルール

上記のディレクトリにあるファイルをすべて読み込み、`count >= 3` のルールは必ず遵守する。

### 指摘を受けたとき

同じ内容の指摘・訂正・好みを受けるたびに `.claude/feedback/` or `~/.claude/feedback/` のファイルを作成または更新して `count` をインクリメントする。**返答する前に必ず**行うこと。
まず、今回の指摘を保存するかどうかをユーザーに確認する。ユーザーが保存することを選択した場合、に保存すること。
記録する際は、具体的な内容をそのまま書くのではなく抽象的な指摘に変換して残す。
記録する際は言い訳を記述し、その言い訳に対して指摘事項を残す。

- **count が 3 未満**：記録はするが、まだ暫定ルール（状況に応じて判断してよい）
- **count が 3 以上**：確定ルールとして常に従う

### フィードバックファイルのフォーマット

```markdown
---
name: （フィードバックの名前）
description: （1行の説明）
type: feedback
count: 1
expires: 2026-12-31          # 任意。この日付を過ぎたらルールは無効
projects: ['~/src/myorg/**']  # 任意。マッチするプロジェクトでだけ適用
when_exists: ['go.mod']      # 任意。この glob が存在するプロジェクトでだけ適用
---

（ルール本文）

**Why:** （ユーザーが指摘した理由）

**How to apply:** （いつ・どこでこのルールを適用するか）
```

`expires` / `projects` / `when_exists` は任意で、3つすべてを満たしたときだけルールが有効になる。

- `expires`：有効期限。`YYYY-MM-DD` ならその日の終わり（UTC）まで、それ以外は ISO 8601 日時。過ぎたルールは注入も強制もされない。解釈できない値は無視（無期限）
- `projects`：文字列または配列。プロジェクトディレクトリの絶対パスにマッチする glob（`**` は `/` を跨ぐ。先頭の `~` は HOME に展開）。1つでもマッチすれば適用
- `when_exists`：文字列または配列。プロジェクトルート相対の glob。1つでも存在すれば適用

特定言語向けのルールや一時的なルールに使う。グローバルとプロジェクトで同名のルールがあるとき、プロジェクト側が無効ならグローバル側も使われない。

### ファイル命名規則

`.claude/feedback/<topic>.md`, `~/.claude/feedback/<topic>.md` — トピックを英語のスネークケースで命名する（例: `tsconfig_rootdir.md`, `test_mocking.md`）

### enforce（count に応じた強制力）

hook（`src/feedback-guard.ts` / `src/feedback-stop-check.ts`）が実際にルールを
検知・強制できる場合は、frontmatter に `enforce:` を追記できる。`src/feedback-rules.ts`
がこれを読み、PreToolUse（Bash / Edit・Write・MultiEdit）と Stop で評価する。

```yaml
enforce:
  - event: pre_bash          # PreToolUse(Bash) でコマンド文字列を検査
    when: '正規表現'          # 必須。command にマッチしたら候補
    unless: '正規表現'        # 任意。これにマッチするなら違反ではない
    check: 'shell cmd'       # 任意。非0終了で違反確定（when と AND）
    message: '違反時に出す指示文'
    severity: deny           # 任意。省略時は count から自動決定

  - event: pre_edit          # PreToolUse(Edit|Write|MultiEdit) で対象と内容を検査
    path: 'glob'             # 必須。file_path にマッチ
    exclude_path: 'glob'     # 任意。文字列または配列。path にマッチしても
                             # これにマッチしたら検査対象外
    when: '正規表現'          # 任意。new_string / content / new_source に対して
    unless: '正規表現'        # 任意
    absent_sibling: 'name'   # 任意。同ディレクトリにこの名前のファイルが無ければ違反
                             # ({stem} はファイル名（拡張子抜き）に置換される)
    absent_glob: 'glob'      # 任意。文字列または配列。プロジェクトルート起点の glob で、
                             # どれか1つでも存在すれば違反にしない（spec/ や tests/ など
                             # 別ツリーのテストを拾う）。{stem} と {dir}（プロジェクト相対
                             # ディレクトリ）を展開する。absent_sibling とは OR

  - event: stop_check        # Stop 時、そのセッションの変更ファイルを検査
    changed: 'glob'          # 必須
    check: 'shell cmd'       # 任意。$FILE に該当ファイルパスが入る。非0で違反
    require_sibling: 'name'  # 任意。同ディレクトリにこのファイルが無ければ違反
    message: '...'
```

glob は `*` が `/` を跨がない、`**` が跨ぐ、`{a,b}` 展開に対応する（`src/glob.ts`
の `globToRegex` と同じ挙動）。

`severity` を省略した場合、`count` から自動決定される（`event` が `stop_check` かどうかで
count 3・4 の扱いが変わる）。

| count | pre_bash / pre_edit | stop_check |
| ----- | ------------------- | ---------- |
| >= 5  | `deny`              | `deny`     |
| 3〜4  | `ask`               | `block`    |
| 1〜2  | `warn`              | `warn`     |

- `deny` / `block`：ツール呼び出しを止める（PreToolUse は `permissionDecision: deny`、Stop は exit 2）
- `ask`：ユーザーに確認を求める（PreToolUse `permissionDecision: ask`）
- `warn`：stderr に警告を出すのみで、処理は継続する

違反は `~/.claude/feedback/.violations.jsonl` に追記される（`count` 自体は書き換えない）。
