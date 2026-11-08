---
name: no_console_log
description: デバッグ用の console.log を残さない
type: feedback
count: 4
files: ['web/**/*.{ts,tsx}']
enforce:
  - event: pre_edit
    when: 'console\.log\('
    message: 'console.log を残さない（logger を使う）'
  - event: post_edit
    when: 'console\.log\('
    message: 'console.log が残っている'
---

console.log を残さない。
