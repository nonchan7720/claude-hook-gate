---
name: migration_down
description: マイグレーションには down を付ける
type: feedback
count: 5
enforce:
  - event: stop_check
    changed: 'db/migrations/*.up.sql'
    require_sibling: '{stem}.down.sql'
    message: '対応する .down.sql を書く'
---

マイグレーションは up と down を揃える。
