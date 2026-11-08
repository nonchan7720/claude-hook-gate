---
name: gofmt_clean
description: 変更した Go ファイルを gofmt 済みにする
type: feedback
count: 3
enforce:
  - event: stop_check
    changed: '**/*.go'
    check: 'test -z "$(gofmt -l "$FILE")"'
    message: 'gofmt -w をかける'
---

Go は gofmt 済みにする。
