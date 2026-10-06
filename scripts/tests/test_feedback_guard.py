"""feedback-guard.py (PreToolUse hook) の統合テスト。

stdin から hook JSON を渡して起動し、stdout/stderr/exit code を検証する。
ファイル名がハイフンを含むため import ではなく subprocess で実行する。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(HOOKS_DIR, "feedback-guard.py")


def run_guard(payload, feedback_dir, project_dir=None):
    env = dict(os.environ)
    env["CLAUDE_FEEDBACK_DIR"] = feedback_dir
    if project_dir:
        env["CLAUDE_PROJECT_DIR"] = project_dir
    r = subprocess.run(
        [sys.executable, GUARD],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return r


class FeedbackGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._write_rule(
            "dont_run_tests_manually.md",
            count=6,
            enforce=textwrap.dedent(
                """\
                enforce:
                  - event: pre_bash
                    when: '(^|&&|\\|\\||;)\\s*go test\\b'
                    message: 'hookに任せてBashで手動実行しない'
                    severity: deny
                """
            ),
        )
        self._write_rule(
            "tdd.md",
            count=6,
            enforce=textwrap.dedent(
                """\
                enforce:
                  - event: pre_edit
                    path: '**/*.go'
                    absent_sibling: '{stem}_test.go'
                    message: '先にテストファイルを書くこと'
                    severity: ask
                """
            ),
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_rule(self, filename, count, enforce):
        content = (
            "---\n"
            f"name: {filename[:-3]}\n"
            "description: test\n"
            "type: feedback\n"
            f"count: {count}\n"
            f"{enforce}"
            "---\n\n本文\n"
        )
        with open(os.path.join(self.tmp, filename), "w", encoding="utf-8") as fh:
            fh.write(content)

    def test_deny_for_manual_go_test(self):
        r = run_guard(
            {"tool_name": "Bash", "tool_input": {"command": "go test ./..."}},
            self.tmp,
        )
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout)
        hs = out["hookSpecificOutput"]
        self.assertEqual(hs["hookEventName"], "PreToolUse")
        self.assertEqual(hs["permissionDecision"], "deny")
        self.assertIn("dont_run_tests_manually", hs["permissionDecisionReason"])
        self.assertIn("count: 6", hs["permissionDecisionReason"])

    def test_passes_for_unrelated_bash_command(self):
        r = run_guard({"tool_name": "Bash", "tool_input": {"command": "ls -la"}}, self.tmp)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_ask_for_missing_test_sibling_on_write(self):
        with tempfile.TemporaryDirectory() as proj:
            foo = os.path.join(proj, "foo.go")
            r = run_guard(
                {
                    "tool_name": "Write",
                    "tool_input": {"file_path": foo, "content": "package main"},
                },
                self.tmp,
                project_dir=proj,
            )
            self.assertEqual(r.returncode, 0)
            out = json.loads(r.stdout)
            self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_passes_when_test_sibling_exists(self):
        with tempfile.TemporaryDirectory() as proj:
            foo = os.path.join(proj, "foo.go")
            open(os.path.join(proj, "foo_test.go"), "w").close()
            r = run_guard(
                {
                    "tool_name": "Write",
                    "tool_input": {"file_path": foo, "content": "package main"},
                },
                self.tmp,
                project_dir=proj,
            )
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout.strip(), "")

    def test_second_ask_in_same_session_and_file_downgrades_to_warn(self):
        with tempfile.TemporaryDirectory() as proj:
            foo = os.path.join(proj, "foo.go")
            payload = {
                "session_id": "sess-ask-dedup",
                "tool_name": "Write",
                "tool_input": {"file_path": foo, "content": "package main"},
            }
            r1 = run_guard(payload, self.tmp, project_dir=proj)
            out1 = json.loads(r1.stdout)
            self.assertEqual(out1["hookSpecificOutput"]["permissionDecision"], "ask")

            r2 = run_guard(payload, self.tmp, project_dir=proj)
            self.assertEqual(r2.stdout.strip(), "")
            self.assertIn("tdd", r2.stderr)
            self.assertIn("warn", r2.stderr)

            violations_log = os.path.join(self.tmp, ".violations.jsonl")
            with open(violations_log, encoding="utf-8") as fh:
                entries = [json.loads(line) for line in fh if line.strip()]
            second_run_entries = [e for e in entries if e["rule"] == "tdd"]
            self.assertEqual(second_run_entries[-1]["severity"], "warn")

    def test_ask_for_different_file_in_same_session_is_not_suppressed(self):
        with tempfile.TemporaryDirectory() as proj:
            foo = os.path.join(proj, "foo.go")
            bar = os.path.join(proj, "bar.go")
            payload_common = {"session_id": "sess-ask-dedup-2", "tool_name": "Write"}
            r1 = run_guard(
                {**payload_common, "tool_input": {"file_path": foo, "content": "package main"}},
                self.tmp,
                project_dir=proj,
            )
            r2 = run_guard(
                {**payload_common, "tool_input": {"file_path": bar, "content": "package main"}},
                self.tmp,
                project_dir=proj,
            )
            for r in (r1, r2):
                out = json.loads(r.stdout)
                self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_ask_without_session_id_is_not_suppressed(self):
        with tempfile.TemporaryDirectory() as proj:
            foo = os.path.join(proj, "foo.go")
            payload = {
                "tool_name": "Write",
                "tool_input": {"file_path": foo, "content": "package main"},
            }
            r1 = run_guard(payload, self.tmp, project_dir=proj)
            r2 = run_guard(payload, self.tmp, project_dir=proj)
            for r in (r1, r2):
                out = json.loads(r.stdout)
                self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_deny_violation_is_not_downgraded_and_repeats(self):
        payload = {
            "session_id": "sess-deny-repeat",
            "tool_name": "Bash",
            "tool_input": {"command": "go test ./..."},
        }
        r1 = run_guard(payload, self.tmp)
        r2 = run_guard(payload, self.tmp)
        for r in (r1, r2):
            out = json.loads(r.stdout)
            self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_never_fails_hard_on_garbage_stdin(self):
        env = dict(os.environ)
        env["CLAUDE_FEEDBACK_DIR"] = self.tmp
        r = subprocess.run(
            [sys.executable, GUARD], input="not json {{{", capture_output=True, text=True, env=env, timeout=30
        )
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
