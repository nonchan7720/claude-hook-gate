#!/usr/bin/env python3
"""UserPromptSubmit hook (global): count >= 3 の確定 feedback ルールをコンテキストに
注入する。rules.md 自体は別 hook (cat) が出しているので、ここでは出力しない。

count 降順・同数なら name 昇順で並べ、各ルールは
「■ <name> (これまで N 回指摘されています)」+ description + 本文の第1段落を出力する。

hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feedback_rules as fr

HEADER = (
    "# 確定フィードバックルール（count >= 3）\n"
    "これらは繰り返し指摘された確定ルール。違反すると hook がブロックする。\n\n"
)


def format_full(rule):
    lines = [f"■ {rule['name']} (これまで {rule['count']} 回指摘されています)", rule["description"]]
    intro = fr.load_body_intro(rule["path"])
    if intro:
        lines.append(intro)
    return "\n".join(lines)


def build_output(rules):
    ordered = sorted(rules, key=lambda r: (-r["count"], r["name"]))
    return HEADER + "\n\n".join(format_full(r) for r in ordered)


def main():
    try:
        sys.stdin.read()
    except Exception:
        pass

    rules = [r for r in fr.list_rules() if r["count"] >= 3]
    if not rules:
        return 0

    sys.stdout.write(build_output(rules))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:  # hook のバグで作業を止めない
        sys.stderr.write(f"[feedback-inject] internal error (ignored): {e}\n")
        sys.exit(0)
