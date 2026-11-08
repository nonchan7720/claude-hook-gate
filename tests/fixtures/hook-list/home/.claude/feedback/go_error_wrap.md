---
name: go_error_wrap
description: Go のエラーは文脈を付けて包む
type: feedback
count: 3
files: ['**/*.go']
exclude_files: ['**/*_test.go']
enforce:
  - event: post_edit
    when: '^\s*return\s+(nil,\s*)?err\s*$'
    message: 'fmt.Errorf("...: %w", err) で包む'
---

Go のエラーは fmt.Errorf で包んで返す。
