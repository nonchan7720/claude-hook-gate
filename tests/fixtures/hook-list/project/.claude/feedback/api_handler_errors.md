---
name: api_handler_errors
description: API ハンドラはエラーを HTTP ステータスに写す
type: feedback
count: 3
files: ['internal/server/**/*.go']
enforce:
  - event: pre_edit
    when: 'http\.Error\(w,\s*err\.Error\(\)'
    message: '内部エラーの文面をそのまま返さない（apierror.Write を使う）'
---

ハンドラのエラーは apierror で返す。
