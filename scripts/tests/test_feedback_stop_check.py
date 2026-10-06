"""feedback-stop-check.py (Stop hook) の統合テスト。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(HOOKS_DIR, "feedback-stop-check.py")


def run_stop_check(payload, feedback_dir, project_dir, session_id="sess1"):
    env = dict(os.environ)
    env["CLAUDE_FEEDBACK_DIR"] = feedback_dir
    env["CLAUDE_PROJECT_DIR"] = project_dir
    env["CLAUDE_SESSION_ID"] = session_id
    payload = dict(payload)
    payload.setdefault("session_id", session_id)
    r = subprocess.run(
        [sys.executable, SCRIPT],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return r


class FeedbackStopCheckTest(unittest.TestCase):
    def setUp(self):
        self.feedback_dir = tempfile.mkdtemp()
        self.project_dir = tempfile.mkdtemp()
        content = (
            "---\n"
            "name: readme_bilingual\n"
            "description: test\n"
            "type: feedback\n"
            "count: 4\n"
            "enforce:\n"
            "  - event: stop_check\n"
            "    changed: '**/README.md'\n"
            "    require_sibling: 'README_ja.md'\n"
            "    message: '日英併記のこと'\n"
            "    severity: block\n"
            "---\n\n本文\n"
        )
        with open(os.path.join(self.feedback_dir, "readme_bilingual.md"), "w", encoding="utf-8") as fh:
            fh.write(content)

    def tearDown(self):
        shutil.rmtree(self.feedback_dir, ignore_errors=True)
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def _write_memo(self, *rel_paths):
        claude_dir = os.path.join(self.project_dir, ".claude", ".gate-status")
        os.makedirs(claude_dir, exist_ok=True)
        with open(os.path.join(claude_dir, "changed_files.sess1.txt"), "w") as fh:
            for p in rel_paths:
                fh.write(p + "\n")

    def _write_agent_memo(self, session_id, agent_id, *rel_paths):
        claude_dir = os.path.join(self.project_dir, ".claude", ".gate-status")
        os.makedirs(claude_dir, exist_ok=True)
        with open(os.path.join(claude_dir, f"changed_files.{session_id}--{agent_id}.txt"), "w") as fh:
            for p in rel_paths:
                fh.write(p + "\n")

    def test_blocks_when_readme_ja_missing(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_memo("README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 2)
        self.assertIn("readme_bilingual", r.stderr)

    def test_passes_when_readme_ja_present(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        open(os.path.join(self.project_dir, "README_ja.md"), "w").close()
        self._write_memo("README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 0)

    def test_no_changed_files_passes(self):
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 0)

    def test_gives_up_after_max_attempts(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_memo("README.md")
        for i in range(3):
            r = run_stop_check({}, self.feedback_dir, self.project_dir)
        # 3回連続ブロック後は諦めて exit 0 になる
        self.assertEqual(r.returncode, 0)

    def test_agent_id_from_payload_is_used_for_changed_files_and_attempts(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_agent_memo("sess1", "agent1", "README.md")
        r = run_stop_check({"agent_id": "agent1"}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 2)
        agent_attempts = os.path.join(
            self.project_dir, ".claude", ".gate-status", "feedback_gate_attempts.sess1--agent1.txt"
        )
        plain_attempts = os.path.join(
            self.project_dir, ".claude", ".gate-status", "feedback_gate_attempts.sess1.txt"
        )
        self.assertTrue(os.path.exists(agent_attempts))
        self.assertFalse(os.path.exists(plain_attempts))

    def test_main_stop_picks_up_agent_suffixed_memo_via_merge(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_agent_memo("sess1", "agent1", "README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 2)
        plain_attempts = os.path.join(
            self.project_dir, ".claude", ".gate-status", "feedback_gate_attempts.sess1.txt"
        )
        self.assertTrue(os.path.exists(plain_attempts))

    def test_blocking_emits_block_json_with_reason_and_attempt_count(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_memo("README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 2)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("readme_bilingual", payload["reason"])
        self.assertIn("試行", payload["reason"])

    def test_stdout_is_exactly_one_json_object(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_memo("README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 2)
        decoder = json.JSONDecoder()
        _, end = decoder.raw_decode(r.stdout.strip())
        self.assertEqual(r.stdout.strip()[end:].strip(), "")

    def test_success_stdout_has_no_block_json(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        open(os.path.join(self.project_dir, "README_ja.md"), "w").close()
        self._write_memo("README.md")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_max_attempts_giveup_has_no_block_json(self):
        open(os.path.join(self.project_dir, "README.md"), "w").close()
        self._write_memo("README.md")
        for i in range(3):
            r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_warn_only_violation_has_no_block_json(self):
        content = (
            "---\n"
            "name: warn_rule\n"
            "description: test\n"
            "type: feedback\n"
            "count: 1\n"
            "enforce:\n"
            "  - event: stop_check\n"
            "    changed: '**/*.txt'\n"
            "    check: 'false'\n"
            "    message: 'warn only'\n"
            "    severity: warn\n"
            "---\n\n本文\n"
        )
        with open(os.path.join(self.feedback_dir, "warn_rule.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        open(os.path.join(self.project_dir, "x.txt"), "w").close()
        self._write_memo("x.txt")
        r = run_stop_check({}, self.feedback_dir, self.project_dir)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        self.assertIn("warn_rule", r.stderr)

    def test_never_fails_hard_on_garbage_stdin(self):
        env = dict(os.environ)
        env["CLAUDE_FEEDBACK_DIR"] = self.feedback_dir
        env["CLAUDE_PROJECT_DIR"] = self.project_dir
        r = subprocess.run(
            [sys.executable, SCRIPT], input="{{{not json", capture_output=True, text=True, env=env, timeout=30
        )
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
