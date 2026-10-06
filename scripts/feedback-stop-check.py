#!/usr/bin/env python3
"""Stop hook (global): feedback ルールの stop_check enforce を評価する。

変更ファイルの一覧は record-changes.sh が書く
${CLAUDE_PROJECT_DIR}/.claude/changed_files.${SESSION_ID}[--${AGENT_ID}].txt を優先して読む
（gate.yaml を持つプロジェクトでしか作られないため、無ければ
feedback_rules.get_changed_files() が git diff / git status でフォールバックする）。
payload に agent_id があれば SubagentStop（サブエージェントの Stop）とみなし、
そのエージェント別メモ・attempts ファイル（feedback_gate_attempts.${SESSION_ID}--${AGENT_ID}.txt）
だけを見る。

severity が warn 以外（block/ask/deny）の違反があれば stderr に出して exit 2
（修正を継続させる）。warn のみなら stderr に出して exit 0。

既存の stop-test-gate.sh とは別に settings.json の Stop に追加登録する想定で、
既存エントリを置き換えない。

無限ループ防止のため、MAX_ATTEMPTS 回連続でブロックしたら諦めて exit 0 にする
（stop-gate.py の MAX_ATTEMPTS と同じ思想）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feedback_rules as fr

MAX_ATTEMPTS = 3


def attempts_path(project_dir, session_id, agent_id=None):
    state_id = f"{session_id}--{agent_id}" if agent_id else session_id
    return os.path.join(project_dir, ".claude", f"feedback_gate_attempts.{state_id}.txt")


def clear_attempts(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def bump_attempts(path):
    attempts = 0
    try:
        attempts = int(open(path).read().strip())
    except Exception:
        attempts = 0
    attempts += 1
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(str(attempts))
    except OSError:
        pass
    return attempts


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    session_id = payload.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "unknown"
    agent_id = payload.get("agent_id") or None
    ap = attempts_path(project_dir, session_id, agent_id)

    files = fr.get_changed_files(project_dir, session_id, agent_id)
    if not files:
        clear_attempts(ap)
        return 0

    rules = fr.list_rules()
    violations = fr.eval_stop_check(rules, project_dir, files)
    if not violations:
        clear_attempts(ap)
        return 0

    for v in violations:
        fr.log_violation(v["rule"], v["count"], v["severity"], v["event"], v["detail"])

    warnings = [v for v in violations if v["severity"] == "warn"]
    blocking = [v for v in violations if v["severity"] != "warn"]

    for v in warnings:
        sys.stderr.write(
            f"[feedback-stop-check] warn: {v['rule']} (count: {v['count']}): {v['message']}\n"
        )

    if not blocking:
        clear_attempts(ap)
        return 0

    attempts = bump_attempts(ap)
    if attempts >= MAX_ATTEMPTS:
        sys.stderr.write(
            f"[feedback-stop-check] {MAX_ATTEMPTS} 回連続でブロックしました。ループを打ち切ります。手動確認を。\n"
        )
        clear_attempts(ap)
        return 0

    lines = [
        f"[feedback-stop-check] {v['rule']} (count: {v['count']}): {v['message']} ({v['detail']})"
        for v in blocking
    ]
    lines.append(f"[feedback-stop-check] 上記を修正してください（試行 {attempts}/{MAX_ATTEMPTS}）。")
    for line in lines:
        sys.stderr.write(line + "\n")
    print(json.dumps({"decision": "block", "reason": "\n".join(lines)}, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:  # hook のバグで作業を止めない
        sys.stderr.write(f"[feedback-stop-check] internal error (ignored): {e}\n")
        sys.exit(0)
