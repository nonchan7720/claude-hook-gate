# Changelog

## [0.22.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.22.0...v0.22.1) (2026-11-12)


### Documentation

* shorten the README, move the reference into docs/, and enable stop_review in this repository ([#109](https://github.com/nonchan7720/claude-hook-gate/issues/109)) ([6da31a9](https://github.com/nonchan7720/claude-hook-gate/commit/6da31a966468bf156064fb13094fe9a282f0574c))

## [0.22.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.21.0...v0.22.0) (2026-11-12)


### Features

* **gate:** add stop_review, a self-review step at Stop / SubagentStop that switches the effort ([#107](https://github.com/nonchan7720/claude-hook-gate/issues/107)) ([8ea054e](https://github.com/nonchan7720/claude-hook-gate/commit/8ea054e0f779d301a313475858dcef107bcee4e5))

## [0.21.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.20.0...v0.21.0) (2026-11-09)


### Features

* **codex:** setup.sh installs into /etc/codex/hooks.json where Codex runs only managed hooks ([#104](https://github.com/nonchan7720/claude-hook-gate/issues/104)) ([99e7284](https://github.com/nonchan7720/claude-hook-gate/commit/99e7284f4ac6cb20ad795493777b2e7b9f0fb209))


### Documentation

* support Claude Cowork (install steps, limitations, .agents/ fallback for rules) ([#102](https://github.com/nonchan7720/claude-hook-gate/issues/102)) ([23cfe63](https://github.com/nonchan7720/claude-hook-gate/commit/23cfe633c2cc99b90e022a2760115175077ba6de))

## [0.20.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.19.0...v0.20.0) (2026-11-09)


### Features

* **codex:** add setup.sh / feedback-gate-setup, one command that updates the plugin and installs the hooks ([#100](https://github.com/nonchan7720/claude-hook-gate/issues/100)) ([c581b5b](https://github.com/nonchan7720/claude-hook-gate/commit/c581b5b583ef6b58780df2373441cb8c7829bd07))

## [0.19.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.18.0...v0.19.0) (2026-11-08)


### Features

* **feedback:** check existing rules before creating a new feedback rule file ([#93](https://github.com/nonchan7720/claude-hook-gate/issues/93)) ([e87a4a5](https://github.com/nonchan7720/claude-hook-gate/commit/e87a4a5c4960cbbaf3826d670496217b39baab23))


### Continuous Integration

* **ui-screenshots:** do not run on release-please PRs ([#97](https://github.com/nonchan7720/claude-hook-gate/issues/97)) ([724ec18](https://github.com/nonchan7720/claude-hook-gate/commit/724ec18ee86b6cf6066909c8cdf1b8e213157593))

## [0.18.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.17.0...v0.18.0) (2026-11-08)


### Features

* show the registered hooks (gate.yaml and feedback rules) as a page in the browser ([#91](https://github.com/nonchan7720/claude-hook-gate/issues/91)) ([5620ce1](https://github.com/nonchan7720/claude-hook-gate/commit/5620ce18c0e0085eec74bcdd6ff3de3b4a64ef32))


### Bug Fixes

* **gate:** make an unquoted `on:` work in session_start ([#92](https://github.com/nonchan7720/claude-hook-gate/issues/92)) ([fb9a61c](https://github.com/nonchan7720/claude-hook-gate/commit/fb9a61c6d0f66ad08044b7fdf868dabbf3de15a2))

## [0.17.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.16.0...v0.17.0) (2026-11-05)


### Features

* **gate:** return only the log path, not the command output, when a checks phase command fails ([#89](https://github.com/nonchan7720/claude-hook-gate/issues/89)) ([e5c0d04](https://github.com/nonchan7720/claude-hook-gate/commit/e5c0d049d66157e3e2dd16aabe905e2c3c61368b))

## [0.16.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.15.0...v0.16.0) (2026-11-04)


### Features

* **gate:** return only the log path, not the command output, when a rules phase command fails ([#87](https://github.com/nonchan7720/claude-hook-gate/issues/87)) ([f0cef3d](https://github.com/nonchan7720/claude-hook-gate/commit/f0cef3d4d9098a7d24538967679d49ee86e703dd))

## [0.15.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.14.0...v0.15.0) (2026-11-03)


### Features

* **gate:** run session_start commands on SessionStart and add their stdout to the context ([#85](https://github.com/nonchan7720/claude-hook-gate/issues/85)) ([0f15025](https://github.com/nonchan7720/claude-hook-gate/commit/0f1502592e85c810f8d38333d1978f28cf2e294a))


### Bug Fixes

* **codex:** kill the gate commands with the hook when Codex sends SIGKILL ([#80](https://github.com/nonchan7720/claude-hook-gate/issues/80)) ([759b625](https://github.com/nonchan7720/claude-hook-gate/commit/759b625538e53e7f63f5b8185a90792d739ae773))
* **codex:** use the summarized reason, not the whole stderr, for the Stop reason shown in the conversation ([#81](https://github.com/nonchan7720/claude-hook-gate/issues/81)) ([f91eec4](https://github.com/nonchan7720/claude-hook-gate/commit/f91eec4b1ba9af04d853f8ae5702fe36ce10c639))


### Build System

* **deps-dev:** bump the dev-dependencies group across 1 directory with 5 updates ([#57](https://github.com/nonchan7720/claude-hook-gate/issues/57)) ([c87f9ef](https://github.com/nonchan7720/claude-hook-gate/commit/c87f9efbf2e1f5a5471e68ee526c94c20fbb1a6a))
* **deps:** bump jdx/mise-action from 5.2.1 to 5.2.4 in the actions group ([#82](https://github.com/nonchan7720/claude-hook-gate/issues/82)) ([bd0bef1](https://github.com/nonchan7720/claude-hook-gate/commit/bd0bef1a0ce0566285a9542b6b0c68b3183f7cf7))
* **deps:** bump the actions group with 2 updates ([#74](https://github.com/nonchan7720/claude-hook-gate/issues/74)) ([e3feaa9](https://github.com/nonchan7720/claude-hook-gate/commit/e3feaa9f25d3afe882e62fec006d6535b67e5abc))

## [0.14.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.13.0...v0.14.0) (2026-10-29)


### Features

* **codex:** install the hooks where Codex does not run plugin hooks, and keep a copy silent beside them ([#68](https://github.com/nonchan7720/claude-hook-gate/issues/68)) ([67947b8](https://github.com/nonchan7720/claude-hook-gate/commit/67947b816a74876158aaa743f8c1bef2a8c0eee6))
* inject file-scoped feedback rules (`files`) when a matching file is read or edited ([#75](https://github.com/nonchan7720/claude-hook-gate/issues/75)) ([154700d](https://github.com/nonchan7720/claude-hook-gate/commit/154700d6c024389fd45ebbec8769ad2fd21b14bc))


### Bug Fixes

* **shared-run:** decide the lock owner with noclobber, not with mkdir's exit status (CI on ubuntu-26.04) ([#77](https://github.com/nonchan7720/claude-hook-gate/issues/77)) ([45d19b5](https://github.com/nonchan7720/claude-hook-gate/commit/45d19b5b8fc1c01f3dcae6d43202b144bca7488d))

## [0.13.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.12.0...v0.13.0) (2026-10-24)


### Features

* cap concurrent gate commands with max_parallel and batch waiting agents' files into one run ([#72](https://github.com/nonchan7720/claude-hook-gate/issues/72)) ([99b06ca](https://github.com/nonchan7720/claude-hook-gate/commit/99b06ca87389a177fe5b38a7eb553e382069feff))

## [0.12.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.11.0...v0.12.0) (2026-10-23)


### Features

* check heredoc writes in Bash with pre_edit before the command runs ([#70](https://github.com/nonchan7720/claude-hook-gate/issues/70)) ([de9e1c0](https://github.com/nonchan7720/claude-hook-gate/commit/de9e1c085a602a77d6e974c56f78a98ee5446a7f))

## [0.11.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.10.1...v0.11.0) (2026-10-23)


### Features

* bundle feedback and gate skills ([#56](https://github.com/nonchan7720/claude-hook-gate/issues/56)) ([bd4f698](https://github.com/nonchan7720/claude-hook-gate/commit/bd4f69882d672f51036cda3708c8899c046e9b09))

## [0.10.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.10.0...v0.10.1) (2026-10-21)


### Bug Fixes

* keep another session's edits in the same working tree out of this session's Bash changes ([#66](https://github.com/nonchan7720/claude-hook-gate/issues/66)) ([b150d98](https://github.com/nonchan7720/claude-hook-gate/commit/b150d98c5a2b0cdeb59c419fb9ff6bc462aea5c1))

## [0.10.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.9.1...v0.10.0) (2026-10-21)


### Features

* port the command-hook CLI (hooks + Claude/Codex cli) to a single Go binary ([#62](https://github.com/nonchan7720/claude-hook-gate/issues/62)) ([f0bb1e8](https://github.com/nonchan7720/claude-hook-gate/commit/f0bb1e89120ce1e2d986b5e9acddb33010ccc72a))

## [0.9.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.9.0...v0.9.1) (2026-10-21)


### Bug Fixes

* let the settings hook CLI exit when a command leaves a grandchild holding its pipes ([#63](https://github.com/nonchan7720/claude-hook-gate/issues/63)) ([d237c47](https://github.com/nonchan7720/claude-hook-gate/commit/d237c47453c88d6f2656cb23482618f15f3a61bd))

## [0.9.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.8.0...v0.9.0) (2026-10-20)


### Features

* add a Codex plugin (plugins/codex) behind a host interface ([#59](https://github.com/nonchan7720/claude-hook-gate/issues/59)) ([c899662](https://github.com/nonchan7720/claude-hook-gate/commit/c899662f8b4606748cf4f586306623ed38c91b05))


### Bug Fixes

* keep plugin.json in the format release-please writes ([#61](https://github.com/nonchan7720/claude-hook-gate/issues/61)) ([514aa10](https://github.com/nonchan7720/claude-hook-gate/commit/514aa101b5300de0b4d5a6fa1d981729f7279a48))

## [0.8.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.5...v0.8.0) (2026-10-20)


### Features

* run the classic hooks as settings hooks where an organization's guard skips classic.* ([#58](https://github.com/nonchan7720/claude-hook-gate/issues/58)) ([f4477a9](https://github.com/nonchan7720/claude-hook-gate/commit/f4477a92acf80ebc3cca4c557bbaa10220beae18))


### Bug Fixes

* skip changed files that no longer exist in stop_check ([#54](https://github.com/nonchan7720/claude-hook-gate/issues/54)) ([5f157f8](https://github.com/nonchan7720/claude-hook-gate/commit/5f157f823d77b3bfafdb2b149d6d396e260300af))

## [0.7.5](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.4...v0.7.5) (2026-10-17)


### Bug Fixes

* do not record files another session writes in an unrelated worktree during a Bash command ([#48](https://github.com/nonchan7720/claude-hook-gate/issues/48)) ([11fbfa5](https://github.com/nonchan7720/claude-hook-gate/commit/11fbfa5316b6ae112474c21049e669581ac360fb))

## [0.7.4](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.3...v0.7.4) (2026-10-12)


### Bug Fixes

* add privacyPolicyUrl to the plugin manifest ([#44](https://github.com/nonchan7720/claude-hook-gate/issues/44)) ([bbf5cd2](https://github.com/nonchan7720/claude-hook-gate/commit/bbf5cd262eabb3b8d14525dff65ecc1e22f3ddb2))

## [0.7.3](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.2...v0.7.3) (2026-10-12)


### Bug Fixes

* clear remaining plugin directory findings ([#41](https://github.com/nonchan7720/claude-hook-gate/issues/41)) ([0a6a43b](https://github.com/nonchan7720/claude-hook-gate/commit/0a6a43b5fb82e493325f95648b7518172aa132db))
* hand the PreToolUse event whole to a helper instead of destructuring it ([#43](https://github.com/nonchan7720/claude-hook-gate/issues/43)) ([5413633](https://github.com/nonchan7720/claude-hook-gate/commit/5413633122caac78360ef91529e4bd816c238fb9))

## [0.7.2](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.1...v0.7.2) (2026-10-12)


### Bug Fixes

* address plugin directory validation findings ([#39](https://github.com/nonchan7720/claude-hook-gate/issues/39)) ([d26dc04](https://github.com/nonchan7720/claude-hook-gate/commit/d26dc04dfe041cdcbbec2b14507e83c33be61ebc))

## [0.7.1](https://github.com/nonchan7720/claude-hook-gate/compare/v0.7.0...v0.7.1) (2026-10-12)


### Build System

* split vendor libraries out of the bundle and fill plugin manifests for directory submission ([#37](https://github.com/nonchan7720/claude-hook-gate/issues/37)) ([3fed91b](https://github.com/nonchan7720/claude-hook-gate/commit/3fed91beaea179254abaa44f58d4820e3115d06a))

## [0.7.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.6.0...v0.7.0) (2026-10-12)


### Features

* hand the hook results of a finished subagent to the calling agent ([#35](https://github.com/nonchan7720/claude-hook-gate/issues/35)) ([e66745d](https://github.com/nonchan7720/claude-hook-gate/commit/e66745d93bec8752dda1fea73bd58aa22e1dedc2))

## [0.6.0](https://github.com/nonchan7720/claude-hook-gate/compare/v0.5.1...v0.6.0) (2026-10-11)


### Features

* check files written by Bash with the post_edit / pre_edit feedback rules ([#31](https://github.com/nonchan7720/claude-hook-gate/issues/31)) ([4d6c4dc](https://github.com/nonchan7720/claude-hook-gate/commit/4d6c4dc10bac0862e7520b041ca895d4f4bb14dc))
* raise a feedback rule's count automatically when a hook detects a violation ([#30](https://github.com/nonchan7720/claude-hook-gate/issues/30)) ([a2a96c8](https://github.com/nonchan7720/claude-hook-gate/commit/a2a96c81d6f9192a2a8bbea8371bfce88ecf415a))


### Bug Fixes

* block the stop while a rules failure is left unfixed ([#29](https://github.com/nonchan7720/claude-hook-gate/issues/29)) ([cf7bc36](https://github.com/nonchan7720/claude-hook-gate/commit/cf7bc363c1d780d746c487ffe8d4f3fd329971d1))
* catch Bash edits into worktrees and edits committed in the same command ([#28](https://github.com/nonchan7720/claude-hook-gate/issues/28)) ([d833cb2](https://github.com/nonchan7720/claude-hook-gate/commit/d833cb28bb02036abeb7c542bf6ea2d61ec739ae))
* keep the other feedback rules working when one rule file is broken ([#32](https://github.com/nonchan7720/claude-hook-gate/issues/32)) ([6651d27](https://github.com/nonchan7720/claude-hook-gate/commit/6651d27c06a0084b2474cabebb4ee754bdc5e525))
* run the same gate command one at a time across agents ([#33](https://github.com/nonchan7720/claude-hook-gate/issues/33)) ([9380d6a](https://github.com/nonchan7720/claude-hook-gate/commit/9380d6ad83984d86afb74fe37d71a1136731c866))
* serialize the same gate command across git worktrees of one repository ([#34](https://github.com/nonchan7720/claude-hook-gate/issues/34)) ([07b248c](https://github.com/nonchan7720/claude-hook-gate/commit/07b248ce0ddaec7b95faf59a958bec0206431960))


### Documentation

* fix plugin install instructions to add the marketplace first ([#26](https://github.com/nonchan7720/claude-hook-gate/issues/26)) ([9c59ace](https://github.com/nonchan7720/claude-hook-gate/commit/9c59ace998fbfe0d633232516325fc96d337a556))

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
