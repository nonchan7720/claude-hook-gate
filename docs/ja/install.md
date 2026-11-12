# インストール

[← README](../../README_ja.md) · [English](../install.md)

## Claude Code

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

1 行目でこのリポジトリをマーケットプレイスとして追加し、2 行目でプラグインを入れます。そのあとスコープを選びます。

## Codex

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

続けて `/plugins` から `feedback-gate` を入れ、`install-hooks.sh` を 1 回実行し、`/hooks` でフックを信頼します。手順の詳細と Claude Code との違いは [Codex プラグインの README](../../plugins/codex/README_ja.md) にあります。

- ルールと `gate.yaml` は Claude Code と共通です。Codex は `.agents/` を先に、次に `.claude/` を見ます。
- Codex のサンドボックスは `.agents/` と `.codex/` への書き込みを止めるので、Codex に育てさせるルールは `.claude/` に置きます。
- 組織が管理層のフックだけを許可している環境では、セットアップコマンドが管理層（`/etc/codex/hooks.json`）への導入を案内します。

## Claude Cowork

Cowork の **Customize → Plugins → Add marketplace** で `nonchan7720/claude-hook-gate` を追加し、`feedback-gate` を入れます。検査は Go 製バイナリが行います（[組織管理の環境](managed-environments.md)と同じ経路）。Claude Code との違いは次のとおりです。

| 項目 | Cowork では |
| --- | --- |
| `/correct`、`/hook-list` | 出ません。スキル `/feedback-gate:feedback`、`/feedback-gate:hook-list` を使います |
| プラグイン設定 | 尋ねられないので既定値で動きます。言語は `FEEDBACK_GATE_LANG` か OS の言語で決まります |
| バイナリの取得 | 初回に GitHub のリリースから取得します。`bash`、`curl` か `wget`、`tar`、`sha256sum` か `shasum` と、`github.com`・`release-assets.githubusercontent.com` への HTTPS が必要です |
| Windows | 今のところフックは動きません |
| プロジェクトのルールと `gate.yaml` | Cowork は `.claude/` への書き込みを止めるので、`<project>/.agents/feedback/` と `<project>/.agents/gate.yaml` に置きます |
| グローバルのルール | `~/.claude/feedback/` は Cowork の作業フォルダの外なので、自分でコピーします |

Cowork がどのイベントを発火させるかは公式の一覧がありません。入れたら、確定ルールが注入されるか、ファイル編集後にゲートが走るかを確かめてください。

## 前提

Claude Code では追加で入れるものはありません。

| ツール | 必要な場面 |
| --- | --- |
| `bash`、`curl` か `wget`、`tar`、`sha256sum` か `shasum` | 組織管理の環境と Cowork で、バイナリをバージョンごとに 1 回取得するとき |
| `terminal-notifier` | macOS のデスクトップ通知 |
| `dogwood` | ゲートの各コマンドを今実行するか後回しにするかの判定（任意） |

`dogwood` は `cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli` で入ります。`DOGWOOD_BIN`、`PATH`、`~/.cargo/bin/dogwood`、mise の shim の順に探します。見つからなければ、既定のポリシーが適用されるコマンドは毎回実行され、`policy:` を指定したコマンドは後回しになります。
