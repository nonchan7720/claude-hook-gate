# Changelog

## [0.5.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.5.0...v0.5.1) (2026-10-10)


### Bug Fixes

* key the Bash start time by tool_use_id so subagent Bash edits reach the gate ([#24](https://github.com/nonchan7720/claude-hook-gate/issues/24)) ([85a8587](https://github.com/nonchan7720/claude-hook-gate/commit/85a8587c462cbc4c70a8f65d331ea55013da1afc))

## [0.5.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.4.1...v0.5.0) (2026-10-10)


### Features

* add /correct command that proposes count bumps and enforce entries ([#21](https://github.com/nonchan7720/claude-hook-gate/issues/21)) ([89dc5a6](https://github.com/nonchan7720/claude-hook-gate/commit/89dc5a65c971b9cf9e942685d536140d3d63e122))
* switch the language of hook messages between Japanese and English ([#23](https://github.com/nonchan7720/claude-hook-gate/issues/23)) ([3813db5](https://github.com/nonchan7720/claude-hook-gate/commit/3813db53912e831e8b5ba014ae72dec86e74f329))

## [0.4.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.4.0...v0.4.1) (2026-10-09)


### Bug Fixes

* share gate runs across agents whose target files differ ([#19](https://github.com/nonchan7720/claude-hook-gate/issues/19)) ([4990708](https://github.com/nonchan7720/claude-hook-gate/commit/4990708a48376318bf096af191eb08f463dd110a))

## [0.4.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.3.1...v0.4.0) (2026-10-09)


### Features

* add expires, projects and when_exists scopes to feedback rules ([#16](https://github.com/nonchan7720/claude-hook-gate/issues/16)) ([d0ab45b](https://github.com/nonchan7720/claude-hook-gate/commit/d0ab45b63103e3213a2f076450cafad0cf5b0247))
* add post_edit event to feedback enforce rules ([#17](https://github.com/nonchan7720/claude-hook-gate/issues/17)) ([fe03e0e](https://github.com/nonchan7720/claude-hook-gate/commit/fe03e0ec511375ecf6046910143d41b858ddb2eb))
* track files changed by Bash commands via mtime ([#15](https://github.com/nonchan7720/claude-hook-gate/issues/15)) ([4a5fc59](https://github.com/nonchan7720/claude-hook-gate/commit/4a5fc5974e2eae20ff3699125dbab36bb11e4be9))


### Bug Fixes

* read project .claude/feedback rules as well as the global ones ([#13](https://github.com/nonchan7720/claude-hook-gate/issues/13)) ([9270219](https://github.com/nonchan7720/claude-hook-gate/commit/9270219844b259eb114de8c2693109881668d045))

## [0.3.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.3.0...v0.3.1) (2026-10-08)


### Bug Fixes

* show only the own session in the gate band ([#11](https://github.com/nonchan7720/claude-hook-gate/issues/11)) ([4b38a62](https://github.com/nonchan7720/claude-hook-gate/commit/4b38a622de36f78d74575604a8fc423be334cb39))

## [0.3.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.2.0...v0.3.0) (2026-10-08)


### Features

* show gate and feedback progress in the UI ([#9](https://github.com/nonchan7720/claude-hook-gate/issues/9)) ([cb71a3b](https://github.com/nonchan7720/claude-hook-gate/commit/cb71a3b3e3c74f3f70a98b1d204529b29930cee7))

## [0.2.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.1.0...v0.2.0) (2026-10-06)


### Code Refactoring

* port scripts to TypeScript ([#1](https://github.com/nonchan7720/claude-hook-gate/issues/1)) ([df07224](https://github.com/nonchan7720/claude-hook-gate/commit/df0722467904068777ecd62280134c5af5ad9510))


### Continuous Integration

* add Biome lint/typecheck workflow ([#4](https://github.com/nonchan7720/claude-hook-gate/issues/4)) ([64e9f46](https://github.com/nonchan7720/claude-hook-gate/commit/64e9f466193cb39dd2f6f3e71d1b4619ecde3394))


### Miscellaneous Chores

* list refactor, docs, build and ci changes in the changelog ([#7](https://github.com/nonchan7720/claude-hook-gate/issues/7)) ([cf57826](https://github.com/nonchan7720/claude-hook-gate/commit/cf57826eb39415a6cff751f5a2bfba337f55b087))

## 0.1.0 (2026-10-06)


### Features

* **hooks:** classic イベントから同梱スクリプトを呼ぶ function hooks を追加 ([1edb93a](https://github.com/nonchan7720/claude-hook-gate/commit/1edb93a7016d221567cdba3392d6531f59fcb6c7))
* **rules:** プロンプトごとに注入する feedback 運用ルールを追加 ([b5f7d1e](https://github.com/nonchan7720/claude-hook-gate/commit/b5f7d1eb805053fca7807cfd391d9a26fec038e5))
* **scripts:** hook スクリプトと gate のスキーマ・既定ポリシーを追加 ([fedba97](https://github.com/nonchan7720/claude-hook-gate/commit/fedba97cc044ac1ea8e7a0cf1cc8e79a1e8d0d5e))
* **scripts:** 状態ファイルとログを .claude/.gate-status/ 配下に書く ([7a7c25c](https://github.com/nonchan7720/claude-hook-gate/commit/7a7c25c38844312fb090711c550dfe3ab7b100d7))
* プラグインとマーケットプレイスのマニフェストを追加 ([a19218a](https://github.com/nonchan7720/claude-hook-gate/commit/a19218a11c46a1a02f1722676dbda2bb2854b9c5))


### Continuous Integration

* add release-please ([#3](https://github.com/nonchan7720/claude-hook-gate/issues/3)) ([8b1f91e](https://github.com/nonchan7720/claude-hook-gate/commit/8b1f91eb64b6e6462c9b2aa7ccee2cc03b0dc2f2))
