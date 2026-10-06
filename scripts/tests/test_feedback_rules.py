"""feedback_rules.py の単体テスト。

count に応じた severity 強制力の中核ロジック（frontmatter パース、severity 解決、
pre_bash / pre_edit / stop_check の enforce 評価、違反ログ）を検証する。
外部依存は増やさず python3 標準の unittest のみを使う。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import feedback_rules as fr

REAL_FEEDBACK_DIR = os.path.expanduser("~/.claude/feedback")


class ListRulesRealDirTest(unittest.TestCase):
    """実際の ~/.claude/feedback/ に対する統合テスト。"""

    def test_reads_exactly_the_md_files_that_have_frontmatter(self):
        # ~/.claude/feedback/ にはルールが日々追加されるため件数をハードコードしない。
        # frontmatter の有無・name の値は fr.list_rules とは独立に正規表現で判定する。
        expected_names = set()
        for filename in os.listdir(REAL_FEEDBACK_DIR):
            if not filename.endswith(".md"):
                continue
            with open(os.path.join(REAL_FEEDBACK_DIR, filename), encoding="utf-8") as fh:
                content = fh.read()
            m = re.match(r"^---\n(.*?\n)---\n", content, re.DOTALL)
            if not m:
                continue
            name_match = re.search(r"^name:\s*(\S+)\s*$", m.group(1), re.MULTILINE)
            if name_match:
                expected_names.add(name_match.group(1))
        rules = fr.list_rules(REAL_FEEDBACK_DIR)
        names = {r["name"] for r in rules}
        self.assertEqual(names, expected_names)

    def test_each_rule_has_name_and_count(self):
        rules = fr.list_rules(REAL_FEEDBACK_DIR)
        for r in rules:
            self.assertTrue(r["name"])
            self.assertIsInstance(r["count"], int)

    def test_logging_a_violation_does_not_change_source_file_count(self):
        rule = next(r for r in fr.list_rules(REAL_FEEDBACK_DIR) if r["name"] == "tdd")
        with open(rule["path"], encoding="utf-8") as fh:
            before = fh.read()
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["CLAUDE_FEEDBACK_DIR"] = tmp
            try:
                fr.log_violation("tdd", rule["count"], "ask", "pre_edit", "test")
            finally:
                del os.environ["CLAUDE_FEEDBACK_DIR"]
        with open(rule["path"], encoding="utf-8") as fh:
            after = fh.read()
        self.assertEqual(before, after)


class GolangConventionsDirectoryRuleTest(unittest.TestCase):
    """golang_conventions.md 1本目の enforce（ディレクトリ構成チェック）が
    テストファイルを対象外にし、severity を warn に下げていることを確認する。"""

    def _load_frontmatter_text(self):
        path = os.path.join(REAL_FEEDBACK_DIR, "golang_conventions.md")
        with open(path, encoding="utf-8") as fh:
            content = fh.read()
        m = re.match(r"^---\n(.*?\n)---\n", content, re.DOTALL)
        return m.group(1)

    def test_directory_rule_excludes_test_files_and_is_warn(self):
        rule = next(r for r in fr.list_rules(REAL_FEEDBACK_DIR) if r["name"] == "golang_conventions")
        entry = rule["enforce"][0]
        self.assertEqual(entry["event"], "pre_edit")
        self.assertIn("**/*_test.go", entry["exclude_path"])
        self.assertIn(
            "pkg/{config,cmd,domain,infrastructure,interfaces,services,internal,tests}/**",
            entry["exclude_path"],
        )
        self.assertEqual(entry["severity"], "warn")

    def test_mini_yaml_parser_reads_array_exclude_path_from_real_frontmatter(self):
        data = fr.mini_yaml_load(self._load_frontmatter_text())
        entry = data["enforce"][0]
        self.assertIsInstance(entry["exclude_path"], list)
        self.assertIn("**/*_test.go", entry["exclude_path"])

    def test_test_file_is_not_flagged_and_non_test_is_warn_only(self):
        # pkg/handler は既存の exclude_path のどのディレクトリにも含まれないので、
        # ディレクトリ構成チェック自体は素通りせず、*_test.go の除外だけが効くことを確認する。
        rule = next(r for r in fr.list_rules(REAL_FEEDBACK_DIR) if r["name"] == "golang_conventions")
        with tempfile.TemporaryDirectory() as tmp:
            handler_dir = os.path.join(tmp, "pkg", "handler")
            os.makedirs(handler_dir)
            server = os.path.join(handler_dir, "server.go")
            server_test = os.path.join(handler_dir, "server_test.go")
            open(server, "w").close()
            open(server_test, "w").close()

            violations = fr.eval_pre_edit([rule], server_test, "package handler", project_dir=tmp)
            self.assertEqual(violations, [])

            violations = fr.eval_pre_edit([rule], server, "package handler", project_dir=tmp)
            self.assertEqual(len(violations), 1)
            self.assertEqual(violations[0]["severity"], "warn")


class VerifyViaHooksWrapperRuleTest(unittest.TestCase):
    """verify_via_hooks.md 1本目の enforce（pre_bash, deny）が、
    mise exec/x・uv run 系・bundle exec・direnv exec・env・time といった
    ラッパー経由の手動実行も検知することを確認する。"""

    def _rule(self):
        return next(r for r in fr.list_rules(REAL_FEEDBACK_DIR) if r["name"] == "verify_via_hooks")

    def test_wrapper_prefixed_commands_are_denied(self):
        rule = self._rule()
        for command in (
            "mise exec -- pytest tests",
            "mise x -- go test ./...",
            "uv run pytest",
            "env FOO=1 pytest tests",
            "bundle exec rspec",
        ):
            with self.subTest(command=command):
                violations = fr.eval_pre_bash([rule], command)
                self.assertTrue(violations, command)
                self.assertEqual(violations[0]["severity"], "deny")

    def test_mise_run_task_is_not_denied(self):
        rule = self._rule()
        for command in ("mise run test", "mise run lint"):
            with self.subTest(command=command):
                self.assertEqual(fr.eval_pre_bash([rule], command), [])

    def test_bare_command_is_still_denied(self):
        rule = self._rule()
        violations = fr.eval_pre_bash([rule], "pytest tests")
        self.assertTrue(violations)
        self.assertEqual(violations[0]["severity"], "deny")

    def test_wrapper_name_without_tool_is_not_a_false_positive(self):
        rule = self._rule()
        self.assertEqual(fr.eval_pre_bash([rule], "mise exec -- echo hi"), [])


class MiniYamlFallbackParserTest(unittest.TestCase):
    """PyYAML / yq どちらも無い環境を想定した自前パーサのテスト。"""

    SAMPLE = (
        "name: sample_rule\n"
        "description: サンプルの説明\n"
        "type: feedback\n"
        "count: 4\n"
        "enforce:\n"
        "  - event: pre_bash\n"
        "    when: 'go (test|vet)\\b'\n"
        "    unless: '--dry-run'\n"
        "    message: 'テストはhookに任せること'\n"
        "    severity: deny\n"
        "  - event: pre_edit\n"
        "    path: '**/*.go'\n"
        "    absent_sibling: '{stem}_test.go'\n"
        "    message: 'テストファイルが先'\n"
        "    severity: ask\n"
        "  - event: stop_check\n"
        "    changed: '**/README.md'\n"
        "    require_sibling: 'README_ja.md'\n"
        "    message: '日英併記のこと'\n"
        "    severity: block\n"
    )

    def test_mini_yaml_load_parses_scalars_and_enforce_list(self):
        data = fr.mini_yaml_load(self.SAMPLE)
        self.assertEqual(data["name"], "sample_rule")
        self.assertEqual(data["description"], "サンプルの説明")
        self.assertEqual(data["count"], 4)
        self.assertIsInstance(data["enforce"], list)
        self.assertEqual(len(data["enforce"]), 3)

    def test_mini_yaml_load_preserves_regex_backslashes_in_single_quotes(self):
        data = fr.mini_yaml_load(self.SAMPLE)
        entry = data["enforce"][0]
        self.assertEqual(entry["event"], "pre_bash")
        self.assertEqual(entry["when"], r"go (test|vet)\b")
        self.assertEqual(entry["unless"], "--dry-run")
        self.assertEqual(entry["severity"], "deny")

    def test_mini_yaml_load_handles_nested_pre_edit_and_stop_check_entries(self):
        data = fr.mini_yaml_load(self.SAMPLE)
        pre_edit = data["enforce"][1]
        self.assertEqual(pre_edit["path"], "**/*.go")
        self.assertEqual(pre_edit["absent_sibling"], "{stem}_test.go")
        stop_check = data["enforce"][2]
        self.assertEqual(stop_check["changed"], "**/README.md")
        self.assertEqual(stop_check["require_sibling"], "README_ja.md")

    def test_load_yaml_text_falls_back_to_mini_parser_when_no_yaml_or_yq(self):
        # yaml import 失敗・yq 不在を強制して、フォールバック経路が同じ結果を返すことを確認する
        real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

        def fake_import(name, *args, **kwargs):
            if name == "yaml":
                raise ImportError("forced for test")
            return real_import(name, *args, **kwargs)

        import builtins
        orig_import = builtins.__import__
        orig_which = fr.which
        builtins.__import__ = fake_import
        fr.which = lambda cmd: None
        try:
            data = fr.load_yaml_text(self.SAMPLE)
        finally:
            builtins.__import__ = orig_import
            fr.which = orig_which
        self.assertEqual(data["name"], "sample_rule")
        self.assertEqual(len(data["enforce"]), 3)


class LoadRuleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, name, content):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        return path

    def test_skips_file_without_frontmatter(self):
        path = self._write("rules.md", "# グローバルルール\n\n本文だけで frontmatter が無い\n")
        self.assertIsNone(fr.load_rule(path))

    def test_parses_minimal_rule_without_enforce(self):
        path = self._write(
            "foo.md",
            "---\nname: foo\ndescription: foo desc\ntype: feedback\ncount: 2\n---\n\n本文\n",
        )
        rule = fr.load_rule(path)
        self.assertEqual(rule["name"], "foo")
        self.assertEqual(rule["count"], 2)
        self.assertEqual(rule["enforce"], [])

    def test_list_rules_on_directory(self):
        self._write(
            "a.md", "---\nname: a\ndescription: d\ntype: feedback\ncount: 1\n---\nbody\n"
        )
        self._write(
            "b.md", "---\nname: b\ndescription: d\ntype: feedback\ncount: 5\n---\nbody\n"
        )
        self._write("rules.md", "# no frontmatter\n")
        rules = fr.list_rules(self.tmp)
        names = sorted(r["name"] for r in rules)
        self.assertEqual(names, ["a", "b"])


class ResolveSeverityTest(unittest.TestCase):
    def test_count_6_is_deny(self):
        self.assertEqual(fr.resolve_severity(6), "deny")

    def test_count_5_is_deny(self):
        self.assertEqual(fr.resolve_severity(5), "deny")

    def test_count_4_is_ask_for_pre_events(self):
        self.assertEqual(fr.resolve_severity(4, event="pre_bash"), "ask")
        self.assertEqual(fr.resolve_severity(4, event="pre_edit"), "ask")

    def test_count_4_is_block_for_stop_check(self):
        self.assertEqual(fr.resolve_severity(4, event="stop_check"), "block")

    def test_count_3_matches_same_boundaries_as_4(self):
        self.assertEqual(fr.resolve_severity(3, event="pre_bash"), "ask")
        self.assertEqual(fr.resolve_severity(3, event="stop_check"), "block")

    def test_count_2_is_warn(self):
        self.assertEqual(fr.resolve_severity(2, event="pre_bash"), "warn")

    def test_count_1_is_warn(self):
        self.assertEqual(fr.resolve_severity(1, event="stop_check"), "warn")

    def test_explicit_severity_overrides_count(self):
        self.assertEqual(fr.resolve_severity(6, explicit="warn"), "warn")
        self.assertEqual(fr.resolve_severity(1, explicit="deny"), "deny")


class GlobHelpersTest(unittest.TestCase):
    def test_double_star_crosses_directories_single_star_does_not(self):
        rx = re.compile(fr.glob_to_regex("**/*.go"))
        self.assertTrue(rx.match("pkg/domain/foo.go"))
        self.assertTrue(rx.match("foo.go"))
        rx2 = re.compile(fr.glob_to_regex("*.go"))
        self.assertFalse(rx2.match("pkg/foo.go"))
        self.assertTrue(rx2.match("foo.go"))

    def test_brace_expansion(self):
        pats = fr.expand_braces("**/action.{yml,yaml}")
        self.assertEqual(set(pats), {"**/action.yml", "**/action.yaml"})

    def test_relativize_strips_project_dir_prefix(self):
        rel = fr.relativize("/repo/.github/workflows/ci.yml", "/repo")
        self.assertEqual(rel, ".github/workflows/ci.yml")


class EvalPreBashTest(unittest.TestCase):
    def _rule(self, count, **entry):
        return {"name": "dont_run_tests_manually", "count": count, "enforce": [entry]}

    def test_go_test_is_flagged(self):
        rule = self._rule(6, event="pre_bash", when=r"(^|&&|\|\||;)\s*go test\b",
                           message="hookに任せる", severity="deny")
        violations = fr.eval_pre_bash([rule], "go test ./...")
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["severity"], "deny")

    def test_unrelated_string_is_not_a_false_positive(self):
        rule = self._rule(6, event="pre_bash", when=r"(^|&&|\|\||;)\s*go test\b",
                           message="hookに任せる", severity="deny")
        violations = fr.eval_pre_bash([rule], "echo go test")
        self.assertEqual(violations, [])

    def test_unless_excludes_draft_pr(self):
        rule = self._rule(2, event="pre_bash", when="gh pr create", unless=r"--draft",
                           message="draftで作成", severity="warn")
        self.assertEqual(fr.eval_pre_bash([rule], "gh pr create --draft"), [])
        violations = fr.eval_pre_bash([rule], "gh pr create")
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["severity"], "warn")

    def test_check_command_confirms_violation_when_nonzero(self):
        rule = self._rule(1, event="pre_bash", when="git commit",
                           check="exit 1", message="保護ブランチ", severity="warn")
        violations = fr.eval_pre_bash([rule], "git commit -m x")
        self.assertEqual(len(violations), 1)

    def test_check_command_zero_exit_means_no_violation(self):
        rule = self._rule(1, event="pre_bash", when="git commit",
                           check="exit 0", message="保護ブランチ", severity="warn")
        violations = fr.eval_pre_bash([rule], "git commit -m x")
        self.assertEqual(violations, [])


class MiniYamlNestedListTest(unittest.TestCase):
    """PyYAML が無い環境でも exclude_path のブロックシーケンスを読めること。"""

    def test_exclude_path_block_sequence(self):
        text = (
            "name: tdd\n"
            "count: 7\n"
            "enforce:\n"
            "  - event: pre_edit\n"
            "    path: '**/*.go'\n"
            "    exclude_path:\n"
            "      - '**/interfaces/**'\n"
            "      - '**/*_iface.go'\n"
            "    absent_sibling: '{stem}_test.go'\n"
        )
        data = fr.mini_yaml_load(text)
        self.assertEqual(
            data["enforce"][0]["exclude_path"],
            ["**/interfaces/**", "**/*_iface.go"],
        )
        self.assertEqual(data["enforce"][0]["absent_sibling"], "{stem}_test.go")


class EvalPreEditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_test_sibling_is_ask(self):
        foo = os.path.join(self.tmp, "foo.go")
        open(foo, "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], foo, "package main", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["severity"], "ask")

    def test_existing_test_sibling_passes(self):
        foo = os.path.join(self.tmp, "foo.go")
        open(foo, "w").close()
        open(os.path.join(self.tmp, "foo_test.go"), "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], foo, "package main", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_test_file_itself_is_excluded(self):
        foo_test = os.path.join(self.tmp, "foo_test.go")
        open(foo_test, "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], foo_test, "package main", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_exclude_path_skips_absent_sibling_check(self):
        iface = os.path.join(self.tmp, "interfaces", "repo.go")
        os.makedirs(os.path.dirname(iface))
        open(iface, "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "exclude_path": ["**/interfaces/**", "**/*_iface.go"],
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], iface, "package interfaces", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_exclude_path_does_not_affect_unmatched_files(self):
        foo = os.path.join(self.tmp, "foo.go")
        open(foo, "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "exclude_path": ["**/interfaces/**"],
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], foo, "package main", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)

    def test_exclude_path_accepts_single_string(self):
        f = os.path.join(self.tmp, "svc_iface.go")
        open(f, "w").close()
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "exclude_path": "**/*_iface.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], f, "package main", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_exclude_path_applies_to_when_pattern_rules(self):
        f = os.path.join(self.tmp, "gen", "x.go")
        os.makedirs(os.path.dirname(f))
        rule = {
            "name": "modern_go_map_any", "count": 1,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "exclude_path": "**/gen/**", "when": r"interface\{\}",
                         "message": "anyを使う", "severity": "warn"}],
        }
        violations = fr.eval_pre_edit([rule], f, "var m map[string]interface{}", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def _rb_rule(self, patterns):
        return {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.rb",
                         "absent_glob": patterns,
                         "message": "先にテストを書く", "severity": "ask"}],
        }

    def _touch(self, *parts):
        p = os.path.join(self.tmp, *parts)
        d = os.path.dirname(p)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        open(p, "w").close()
        return p

    def test_absent_glob_finds_spec_in_separate_tree(self):
        impl = self._touch("app", "models", "user.rb")
        self._touch("spec", "models", "user_spec.rb")
        rule = self._rb_rule(["{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"])
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_flags_when_no_candidate_exists(self):
        impl = self._touch("app", "models", "user.rb")
        rule = self._rb_rule(["{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"])
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["severity"], "ask")

    def test_absent_glob_matches_same_directory_candidate(self):
        impl = self._touch("lib", "user.rb")
        self._touch("lib", "user_spec.rb")
        rule = self._rb_rule(["{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"])
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_accepts_single_string(self):
        impl = self._touch("lib", "user.rb")
        self._touch("spec", "user_spec.rb")
        rule = self._rb_rule("spec/**/{stem}_spec.rb")
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_handles_project_root_file(self):
        impl = self._touch("user.rb")
        self._touch("user_spec.rb")
        rule = self._rb_rule(["{dir}/{stem}_spec.rb"])
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_skips_test_file_itself(self):
        spec = self._touch("spec", "models", "user_spec.rb")
        rule = self._rb_rule(["spec/**/{stem}_spec.rb"])
        violations = fr.eval_pre_edit([rule], spec, "describe User", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_respects_exclude_path(self):
        impl = self._touch("db", "migrate", "001_create_users.rb")
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.rb",
                         "exclude_path": "**/db/migrate/**",
                         "absent_glob": ["spec/**/{stem}_spec.rb"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "class CreateUsers; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_and_absent_sibling_are_ored(self):
        impl = self._touch("lib", "user.rb")
        self._touch("lib", "user_spec.rb")
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.rb",
                         "absent_sibling": "{stem}_spec.rb",
                         "absent_glob": ["spec/**/{stem}_spec.rb"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_expands_braces(self):
        impl = self._touch("src", "user.ts")
        self._touch("src", "__tests__", "user.spec.ts")
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.ts",
                         "absent_glob": ["{dir}/__tests__/{stem}.{test,spec}.ts"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "export const x = 1", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_expands_braces_in_directory_part(self):
        impl = self._touch("src", "user.ts")
        self._touch("tests", "unit", "user.test.ts")
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.ts",
                         "absent_glob": ["{test,tests}/**/{stem}.{test,spec}.ts"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "export const x = 1", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def _py_rule(self, patterns):
        return {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.py",
                         "absent_glob": patterns,
                         "message": "先にテストを書く", "severity": "ask"}],
        }

    def test_absent_glob_matches_snake_case_test_for_kebab_case_impl(self):
        impl = self._touch("hooks", "stop-gate.py")
        self._touch("hooks", "tests", "test_stop_gate.py")
        rule = self._py_rule(["{dir}/tests/test_{stem}.py"])
        violations = fr.eval_pre_edit([rule], impl, "x = 1", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_matches_kebab_case_test_for_snake_case_impl(self):
        impl = self._touch("hooks", "stop_gate.py")
        self._touch("hooks", "tests", "test_stop-gate.py")
        rule = self._py_rule(["{dir}/tests/test_{stem}.py"])
        violations = fr.eval_pre_edit([rule], impl, "x = 1", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_sibling_matches_underscore_variant_for_kebab_case_impl(self):
        impl = self._touch("pkg", "my-handler.go")
        self._touch("pkg", "my_handler_test.go")
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "package main", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_absent_glob_no_separator_stem_still_flags_when_missing(self):
        impl = self._touch("hooks", "gate.py")
        rule = self._py_rule(["{dir}/tests/test_{stem}.py"])
        violations = fr.eval_pre_edit([rule], impl, "x = 1", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["detail"], "missing test file: hooks/tests/test_gate.py")

    def test_absent_glob_kebab_case_impl_without_any_test_still_flags(self):
        impl = self._touch("hooks", "new-thing.py")
        rule = self._py_rule(["{dir}/tests/test_{stem}.py"])
        violations = fr.eval_pre_edit([rule], impl, "x = 1", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)
        detail = violations[0]["detail"]
        self.assertIn("test_new-thing.py", detail)
        self.assertIn("test_new_thing.py", detail)

    def test_absent_sibling_kebab_case_impl_without_any_test_still_flags(self):
        impl = self._touch("pkg", "my-other.go")
        rule = {
            "name": "tdd", "count": 6,
            "enforce": [{"event": "pre_edit", "path": "**/*.go",
                         "absent_sibling": "{stem}_test.go",
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "package main", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)
        detail = violations[0]["detail"]
        self.assertIn("my-other_test.go", detail)
        self.assertIn("my_other_test.go", detail)

    def test_spec_and_underscore_test_files_are_treated_as_test_files(self):
        for parts in (("src", "user.spec.ts"), ("src", "user.spec.tsx"),
                      ("pkg", "user_test.py"), ("lib", "user_test.rb")):
            with self.subTest(parts=parts):
                f = self._touch(*parts)
                self.assertTrue(fr._looks_like_test_file(os.path.basename(f)))

    def test_when_pattern_on_content_flags_violation(self):
        f = os.path.join(self.tmp, "x.go")
        rule = {
            "name": "modern_go_map_any", "count": 1,
            "enforce": [{"event": "pre_edit", "path": "**/*.go", "when": r"interface\{\}",
                         "message": "anyを使う", "severity": "warn"}],
        }
        violations = fr.eval_pre_edit([rule], f, "var m map[string]interface{}", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)

    def test_path_glob_not_matching_is_ignored(self):
        f = os.path.join(self.tmp, "x.rb")
        rule = {
            "name": "modern_go_map_any", "count": 1,
            "enforce": [{"event": "pre_edit", "path": "**/*.go", "when": r"interface\{\}",
                         "message": "anyを使う", "severity": "warn"}],
        }
        violations = fr.eval_pre_edit([rule], f, "interface{}", project_dir=self.tmp)
        self.assertEqual(violations, [])


class EvalStopCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_readme_without_ja_sibling_is_blocked(self):
        open(os.path.join(self.tmp, "README.md"), "w").close()
        rule = {
            "name": "readme_bilingual", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/README.md",
                         "require_sibling": "README_ja.md",
                         "message": "日英併記", "severity": "block"}],
        }
        violations = fr.eval_stop_check([rule], self.tmp, ["README.md"])
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["severity"], "block")

    def test_readme_with_ja_sibling_passes(self):
        open(os.path.join(self.tmp, "README.md"), "w").close()
        open(os.path.join(self.tmp, "README_ja.md"), "w").close()
        rule = {
            "name": "readme_bilingual", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/README.md",
                         "require_sibling": "README_ja.md",
                         "message": "日英併記", "severity": "block"}],
        }
        violations = fr.eval_stop_check([rule], self.tmp, ["README.md"])
        self.assertEqual(violations, [])

    def test_unrelated_changed_file_is_ignored(self):
        rule = {
            "name": "readme_bilingual", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/README.md",
                         "require_sibling": "README_ja.md",
                         "message": "日英併記", "severity": "block"}],
        }
        violations = fr.eval_stop_check([rule], self.tmp, ["main.go"])
        self.assertEqual(violations, [])


class GetChangedFilesTest(unittest.TestCase):
    def test_prefers_changed_files_memo(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_dir = os.path.join(tmp, ".claude", ".gate-status")
            os.makedirs(claude_dir)
            memo = os.path.join(claude_dir, "changed_files.sess1.txt")
            with open(memo, "w") as fh:
                fh.write("a.go\nb.go\n")
            files = fr.get_changed_files(tmp, "sess1")
            self.assertEqual(files, ["a.go", "b.go"])

    def test_falls_back_to_git_when_no_memo(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
            subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=tmp, check=True)
            subprocess.run(["git", "config", "user.name", "t"], cwd=tmp, check=True)
            with open(os.path.join(tmp, "committed.txt"), "w") as fh:
                fh.write("1")
            subprocess.run(["git", "add", "."], cwd=tmp, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp, check=True)
            with open(os.path.join(tmp, "committed.txt"), "w") as fh:
                fh.write("2")
            with open(os.path.join(tmp, "untracked.txt"), "w") as fh:
                fh.write("3")
            files = fr.get_changed_files(tmp, "no-such-session")
            self.assertIn("committed.txt", files)
            self.assertIn("untracked.txt", files)

    def test_agent_id_reads_only_agent_suffixed_memo(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_dir = os.path.join(tmp, ".claude", ".gate-status")
            os.makedirs(claude_dir)
            with open(os.path.join(claude_dir, "changed_files.sess1.txt"), "w") as fh:
                fh.write("main_only.go\n")
            with open(os.path.join(claude_dir, "changed_files.sess1--agent1.txt"), "w") as fh:
                fh.write("agent_only.go\n")
            files = fr.get_changed_files(tmp, "sess1", "agent1")
            self.assertEqual(files, ["agent_only.go"])

    def test_agent_fallback_without_memo_uses_worktree_cwd_and_returns_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            worktree = os.path.join(tmp, ".claude", "worktrees", "agent-agent1")
            os.makedirs(worktree)
            subprocess.run(["git", "init", "-q"], cwd=worktree, check=True)
            subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=worktree, check=True)
            subprocess.run(["git", "config", "user.name", "t"], cwd=worktree, check=True)
            with open(os.path.join(worktree, "committed.txt"), "w") as fh:
                fh.write("1")
            subprocess.run(["git", "add", "."], cwd=worktree, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=worktree, check=True)
            with open(os.path.join(worktree, "committed.txt"), "w") as fh:
                fh.write("2")
            files = fr.get_changed_files(tmp, "sess1", "agent1")
            self.assertEqual(files, [os.path.join(worktree, "committed.txt")])

    def test_agent_fallback_without_worktree_uses_project_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
            subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=tmp, check=True)
            subprocess.run(["git", "config", "user.name", "t"], cwd=tmp, check=True)
            with open(os.path.join(tmp, "untracked.txt"), "w") as fh:
                fh.write("1")
            files = fr.get_changed_files(tmp, "sess1", "agent-without-worktree")
            self.assertIn("untracked.txt", files)

    def test_main_call_merges_plain_and_agent_suffixed_memos(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_dir = os.path.join(tmp, ".claude", ".gate-status")
            os.makedirs(claude_dir)
            with open(os.path.join(claude_dir, "changed_files.sess1.txt"), "w") as fh:
                fh.write("main.go\n")
            with open(os.path.join(claude_dir, "changed_files.sess1--agentA.txt"), "w") as fh:
                fh.write("agentA.go\n")
            with open(os.path.join(claude_dir, "changed_files.sess1--agentB.txt"), "w") as fh:
                fh.write("agentB.go\nmain.go\n")
            files = fr.get_changed_files(tmp, "sess1")
            self.assertEqual(files, ["main.go", "agentA.go", "agentB.go"])

    def test_main_call_with_only_agent_suffixed_memos_does_not_fall_back_to_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_dir = os.path.join(tmp, ".claude", ".gate-status")
            os.makedirs(claude_dir)
            with open(os.path.join(claude_dir, "changed_files.sess1--agentA.txt"), "w") as fh:
                fh.write("agentA.go\n")
            files = fr.get_changed_files(tmp, "sess1")
            self.assertEqual(files, ["agentA.go"])


class SplitRootTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_worktree_path_returns_worktree_root_and_relative(self):
        wt = os.path.join(self.tmp, ".claude", "worktrees", "agent-abc123")
        f = os.path.join(wt, "hooks", "foo.py")
        root, rel = fr.split_root(self.tmp, f)
        self.assertEqual(root, wt)
        self.assertEqual(rel, "hooks/foo.py")

    def test_non_worktree_absolute_path_returns_project_dir(self):
        f = os.path.join(self.tmp, "hooks", "foo.py")
        root, rel = fr.split_root(self.tmp, f)
        self.assertEqual(root, self.tmp)
        self.assertEqual(rel, "hooks/foo.py")

    def test_relative_path_is_treated_as_project_relative(self):
        root, rel = fr.split_root(self.tmp, "hooks/foo.py")
        self.assertEqual(root, self.tmp)
        self.assertEqual(rel, "hooks/foo.py")


class EvalStopCheckWorktreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.worktree = os.path.join(self.tmp, ".claude", "worktrees", "agent-abc")
        os.makedirs(os.path.join(self.worktree, "hooks"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_worktree_file_matches_anchored_glob_by_root_relative_path(self):
        f = os.path.join(self.worktree, "hooks", "foo.py")
        open(f, "w").close()
        rule = {
            "name": "some_rule", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "hooks/**/*.py",
                         "message": "check", "severity": "block", "check": "exit 1"}],
        }
        violations = fr.eval_stop_check([rule], self.tmp, [f])
        self.assertEqual(len(violations), 1)

    def test_require_sibling_checks_worktree_absolute_path(self):
        f = os.path.join(self.worktree, "hooks", "README.md")
        open(f, "w").close()
        rule = {
            "name": "readme_bilingual", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/README.md",
                         "require_sibling": "README_ja.md",
                         "message": "bilingual", "severity": "block"}],
        }
        violations = fr.eval_stop_check([rule], self.tmp, [f])
        self.assertEqual(len(violations), 1)
        open(os.path.join(self.worktree, "hooks", "README_ja.md"), "w").close()
        violations = fr.eval_stop_check([rule], self.tmp, [f])
        self.assertEqual(violations, [])

    def test_check_command_receives_worktree_absolute_file_and_cwd(self):
        f = os.path.join(self.worktree, "hooks", "foo.py")
        open(f, "w").close()
        marker = os.path.join(self.tmp, "marker.txt")
        rule = {
            "name": "some_rule", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/*.py",
                         "message": "check", "severity": "block",
                         "check": f'printf "%s\\n%s" "$FILE" "$(pwd)" > {marker}; exit 1'}],
        }
        fr.eval_stop_check([rule], self.tmp, [f])
        with open(marker) as fh:
            recorded_file, recorded_cwd = fh.read().split("\n")
        self.assertEqual(recorded_file, f)
        self.assertEqual(os.path.realpath(recorded_cwd), os.path.realpath(self.worktree))

    def test_main_tree_check_command_cwd_is_project_dir(self):
        f = os.path.join(self.tmp, "hooks", "bar.py")
        os.makedirs(os.path.dirname(f))
        open(f, "w").close()
        marker = os.path.join(self.tmp, "marker.txt")
        rule = {
            "name": "some_rule", "count": 4,
            "enforce": [{"event": "stop_check", "changed": "**/*.py",
                         "message": "check", "severity": "block",
                         "check": f'printf "%s" "$(pwd)" > {marker}; exit 1'}],
        }
        fr.eval_stop_check([rule], self.tmp, [f])
        with open(marker) as fh:
            recorded_cwd = fh.read()
        self.assertEqual(os.path.realpath(recorded_cwd), os.path.realpath(self.tmp))


class EvalPreEditWorktreeTest(unittest.TestCase):
    """worktree 配下のファイルは worktree ルート相対パスで path/exclude_path/absent_glob を
    判定すること（project_dir 相対のままだと pkg/**/*.go のようなルート起点 glob が
    worktree では効かなくなる）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.worktree = os.path.join(self.tmp, ".claude", "worktrees", "agent-abc")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_worktree_file_matches_project_root_anchored_path_glob(self):
        cmd_dir = os.path.join(self.worktree, "pkg", "cmd")
        os.makedirs(cmd_dir)
        f = os.path.join(cmd_dir, "server.go")
        open(f, "w").close()
        rule = {
            "name": "golang_conventions", "count": 5,
            "enforce": [{"event": "pre_edit", "path": "pkg/**/*.go",
                         "exclude_path": ["pkg/{domain,infrastructure}/**", "**/*_test.go"],
                         "when": r"[\s\S]",
                         "message": "構成に従うこと", "severity": "warn"}],
        }
        violations = fr.eval_pre_edit([rule], f, "package cmd", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)

    def test_worktree_file_under_excluded_dir_is_not_flagged(self):
        domain_dir = os.path.join(self.worktree, "pkg", "domain")
        os.makedirs(domain_dir)
        f = os.path.join(domain_dir, "model.go")
        open(f, "w").close()
        rule = {
            "name": "golang_conventions", "count": 5,
            "enforce": [{"event": "pre_edit", "path": "pkg/**/*.go",
                         "exclude_path": ["pkg/{domain,infrastructure}/**", "**/*_test.go"],
                         "when": r"[\s\S]",
                         "message": "構成に従うこと", "severity": "warn"}],
        }
        violations = fr.eval_pre_edit([rule], f, "package domain", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_worktree_absent_glob_resolves_against_worktree_root(self):
        impl_dir = os.path.join(self.worktree, "app", "models")
        os.makedirs(impl_dir)
        impl = os.path.join(impl_dir, "user.rb")
        open(impl, "w").close()
        spec_dir = os.path.join(self.worktree, "spec", "models")
        os.makedirs(spec_dir)
        open(os.path.join(spec_dir, "user_spec.rb"), "w").close()
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.rb",
                         "absent_glob": ["spec/**/{stem}_spec.rb"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(violations, [])

    def test_worktree_absent_glob_flags_when_only_project_dir_has_the_test(self):
        # プロジェクトルート側に spec があっても worktree 内の実装からは見えない
        # （worktree ルート起点でしか解決しないこと）ことを確認する。
        impl_dir = os.path.join(self.worktree, "app", "models")
        os.makedirs(impl_dir)
        impl = os.path.join(impl_dir, "user.rb")
        open(impl, "w").close()
        spec_dir = os.path.join(self.tmp, "spec", "models")
        os.makedirs(spec_dir)
        open(os.path.join(spec_dir, "user_spec.rb"), "w").close()
        rule = {
            "name": "tdd", "count": 7,
            "enforce": [{"event": "pre_edit", "path": "**/*.rb",
                         "absent_glob": ["spec/**/{stem}_spec.rb"],
                         "message": "先にテストを書く", "severity": "ask"}],
        }
        violations = fr.eval_pre_edit([rule], impl, "class User; end", project_dir=self.tmp)
        self.assertEqual(len(violations), 1)


if __name__ == "__main__":
    unittest.main()
