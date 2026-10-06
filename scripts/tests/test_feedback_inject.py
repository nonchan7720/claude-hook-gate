"""feedback-inject.py (UserPromptSubmit hook) の統合テスト。"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(HOOKS_DIR, "feedback-inject.py")


def run_inject(feedback_dir):
    env = dict(os.environ)
    env["CLAUDE_FEEDBACK_DIR"] = feedback_dir
    r = subprocess.run(
        [sys.executable, SCRIPT], input="{}", capture_output=True, text=True, env=env, timeout=30
    )
    return r


def write_rule(dirpath, name, count, description="desc"):
    content = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "type: feedback\n"
        f"count: {count}\n"
        "---\n\n"
        f"{name} の本文の第一段落。ここが注入される。\n\n"
        "**Why:** 理由の説明。\n"
    )
    with open(os.path.join(dirpath, f"{name}.md"), "w", encoding="utf-8") as fh:
        fh.write(content)


class FeedbackInjectTest(unittest.TestCase):
    def test_only_count_gte_3_is_included(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_rule(tmp, "high", 5)
            write_rule(tmp, "low", 1)
            r = run_inject(tmp)
            self.assertEqual(r.returncode, 0)
            self.assertIn("high", r.stdout)
            self.assertNotIn("low", r.stdout)

    def test_sorted_by_count_desc_then_name_asc(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_rule(tmp, "bbb", 3)
            write_rule(tmp, "aaa", 3)
            write_rule(tmp, "zzz", 6)
            r = run_inject(tmp)
            pos_zzz = r.stdout.index("zzz")
            pos_aaa = r.stdout.index("aaa")
            pos_bbb = r.stdout.index("bbb")
            self.assertLess(pos_zzz, pos_aaa)
            self.assertLess(pos_aaa, pos_bbb)

    def test_all_rules_output_in_full_even_over_3000_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(80):
                write_rule(tmp, f"rule_{i:03d}", 3, description="あ" * 80)
            r = run_inject(tmp)
            self.assertGreater(len(r.stdout), 3000)
            for i in range(80):
                name = f"rule_{i:03d}"
                self.assertIn(name, r.stdout)
                self.assertIn("あ" * 80, r.stdout)
                self.assertIn(f"{name} の本文の第一段落。ここが注入される。", r.stdout)

    def test_no_rules_produces_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_rule(tmp, "low", 1)
            r = run_inject(tmp)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout.strip(), "")

    def test_never_fails_hard_on_garbage_stdin(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ)
            env["CLAUDE_FEEDBACK_DIR"] = tmp
            r = subprocess.run(
                [sys.executable, SCRIPT], input="{{{not json", capture_output=True, text=True, env=env, timeout=30
            )
            self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
