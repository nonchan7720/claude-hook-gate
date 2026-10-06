#!/usr/bin/env python3
"""PreToolUse hook (global): feedback ルールの enforce (pre_bash / pre_edit) を評価し、
count に応じた強制力（deny / ask / warn）を適用する。

- Bash: command を pre_bash の enforce と照合する
- Edit / Write / MultiEdit: file_path と変更後の内容を pre_edit の enforce と照合する

severity が deny/ask（block は防御的に deny 扱い）の違反があれば stdout に
hookSpecificOutput を出して該当ツール呼び出しを止める。warn のみなら stderr に
書いて exit 0（ツールは実行させる）。違反が無ければ何も出さず exit 0。

hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする
（stderr に1行だけ出す）。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feedback_rules as fr

SEVERITY_ORDER = {"warn": 0, "ask": 1, "block": 2, "deny": 3}


def decision_for(severity):
    """PreToolUse の permissionDecision は allow/deny/ask のみ。block は防御的に deny 扱い。"""
    return "deny" if severity in ("deny", "block") else "ask"


def build_reason(violations):
    lines = [f"{v['rule']} (count: {v['count']}): {v['message']}" for v in violations]
    return "\n".join(lines)


def ask_state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id)
    return os.path.join(fr.feedback_dir(), ".ask_state", f"{safe}.json")


def load_asked_keys(session_id):
    try:
        with open(ask_state_path(session_id), encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("asked"), list):
            return set(data["asked"])
    except Exception:
        pass
    return set()


def save_asked_keys(session_id, asked_keys):
    path = ask_state_path(session_id)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"asked": sorted(asked_keys)}, fh, ensure_ascii=False)
    except Exception:
        pass


def ask_key(violation, tool_input):
    target = tool_input.get("file_path") or "" if violation["event"] == "pre_edit" else ""
    return f"{violation['rule']}|{violation['event']}|{target}"


def downgrade_repeated_asks(violations, session_id, tool_input):
    """同一セッション・同一対象で 2 回目以降の ask は warn に落とす。deny/block は対象外。"""
    if not session_id:
        return
    asked = load_asked_keys(session_id)
    newly_asked = set()
    for v in violations:
        if v["severity"] != "ask":
            continue
        key = ask_key(v, tool_input)
        if key in asked:
            v["severity"] = "warn"
        else:
            newly_asked.add(key)
    if newly_asked:
        save_asked_keys(session_id, asked | newly_asked)


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}

    rules = fr.list_rules()

    if tool_name == "Bash":
        command = tool_input.get("command") or ""
        violations = fr.eval_pre_bash(rules, command)
    elif tool_name in ("Edit", "Write", "MultiEdit"):
        file_path = tool_input.get("file_path") or ""
        if not file_path:
            return 0
        content = fr.extract_pre_edit_content(tool_name, tool_input)
        violations = fr.eval_pre_edit(rules, file_path, content)
    else:
        return 0

    if not violations:
        return 0

    downgrade_repeated_asks(violations, payload.get("session_id"), tool_input)

    for v in violations:
        fr.log_violation(v["rule"], v["count"], v["severity"], v["event"], v["detail"])

    blocking = [v for v in violations if v["severity"] != "warn"]
    warnings = [v for v in violations if v["severity"] == "warn"]

    if blocking:
        top = max(blocking, key=lambda v: SEVERITY_ORDER.get(v["severity"], 0))
        decision = decision_for(top["severity"])
        reason = build_reason(blocking)
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": decision,
                        "permissionDecisionReason": reason,
                    }
                },
                ensure_ascii=False,
            )
        )

    for v in warnings:
        sys.stderr.write(
            f"[feedback-guard] warn: {v['rule']} (count: {v['count']}): {v['message']}\n"
        )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:  # hook のバグで作業を止めない
        sys.stderr.write(f"[feedback-guard] internal error (ignored): {e}\n")
        sys.exit(0)
