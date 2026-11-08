---
name: no_rm_rf_root
description: プロジェクト外を消すコマンドを止める
type: feedback
count: 3
enforce:
  - event: pre_bash
    when: 'rm\s+-[a-z]*r[a-z]*f'
    check: 'test "$PWD" != "$HOME"'
    message: 'rm -rf は対象のパスを確かめてから実行する'
---

rm -rf は対象を確かめる。
