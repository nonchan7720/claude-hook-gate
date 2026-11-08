---
name: conventional_commits
description: コミットメッセージを Conventional Commits にする
type: feedback
count: 2
enforce:
  - event: pre_bash
    when: 'git\s+commit\s+-m\s+\S'
    unless: 'git\s+commit\s+-m\s+.(feat|fix|chore|docs|refactor|test|build|ci)(\(.+\))?!?:'
    message: 'feat: / fix: などの接頭辞を付ける'
---

コミットメッセージは Conventional Commits。
