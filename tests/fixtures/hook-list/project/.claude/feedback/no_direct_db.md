---
name: no_direct_db
description: ハンドラから DB を直接開かない
type: feedback
count: 4
enforce:
  - event: pre_edit
    path: 'internal/handler/**/*.go'
    when: 'sql\.Open\('
    message: 'repository 層を通す'
---

ハンドラは repository 経由で DB に触る。
