---
name: no_force_push
description: force push で他人のコミットを消さない
type: feedback
count: 5
enforce:
  - event: pre_bash
    when: 'git\s+push\b.*\s(--force|-f)\b'
    unless: '--force-with-lease'
    message: 'force push は使わず --force-with-lease を使う'
---

共有ブランチに force push しない。
