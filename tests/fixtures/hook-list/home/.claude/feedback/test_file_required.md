---
name: test_file_required
description: 新しいモジュールにはテストを付ける
type: feedback
count: 3
enforce:
  - event: pre_edit
    path: 'web/src/**/*.ts'
    exclude_path: 'web/src/**/*.d.ts'
    absent_sibling: '{stem}.test.ts'
    message: '同じディレクトリに {stem}.test.ts を作る'
---

モジュールを足すときはテストも足す。
