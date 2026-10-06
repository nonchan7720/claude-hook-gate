"""stop-gate.py (gate hook 本体) の単体・統合テスト。

二相構造（rules フェーズ = PostToolUse / checks フェーズ = Stop・SubagentStop）を
CLAUDE_GATE_PHASE で切り替えてテストする。stop-gate.py はファイル名にハイフンを
含むため `import` できない。テスト対象の importlib ロードでは末尾が
`if __name__ == "__main__":` ガード配下になっている前提で、環境変数を設定してから
spec_from_file_location でロードし、`sys.modules` には登録せずテストごとに独立した
モジュールとして扱う。

end-to-end の挙動（`if __name__ == "__main__":` の安全網、bash ラッパとの結線）は
subprocess で実プロセスとして起動して検証する。
"""
import builtins
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_PATH = os.path.join(HOOKS_DIR, "stop-gate.py")
WRAPPER_PATH = os.path.join(HOOKS_DIR, "stop-test-gate.sh")
RESET_GATE_SCRIPT = os.path.join(HOOKS_DIR, "reset-gate.sh")
RECORD_CHANGES_SCRIPT = os.path.join(HOOKS_DIR, "record-changes.sh")
# 既定ポリシーは policy: を書かなくても適用されるので、DOGWOOD_BIN を差さないと
# PATH や ~/.cargo/bin の実バイナリを拾ってしまう。既定で存在しないパスを差して
# 「dogwood 未導入」を作り、偽バイナリを明示したテストだけが判定経路に乗るようにする。
MISSING_DOGWOOD_BIN = os.path.join(HOOKS_DIR, "tests", "no-such-dogwood")


def load_stop_gate(project_dir, session_id="sess1", stop_hook_active=None, agent_id=None, phase=None,
                   dogwood_bin=None):
    """stop-gate.py を環境変数を設定した状態でロードし、モジュールを返す。
    sys.modules には登録しないので呼び出すたびに独立したモジュールになる。
    phase=None は CLAUDE_GATE_PHASE 未設定（スクリプト側のデフォルト = checks）。
    dogwood_bin は DOGWOOD_BIN に差す偽バイナリのパス。省略時は存在しないパスを差すので
    「dogwood 未導入」として扱われる（テストは実バイナリに依存しない）。"""
    keys = ("CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID", "CLAUDE_STOP_HOOK_ACTIVE",
            "CLAUDE_AGENT_ID", "CLAUDE_GATE_PHASE", "DOGWOOD_BIN")
    backup = {k: os.environ.get(k) for k in keys}
    os.environ["CLAUDE_PROJECT_DIR"] = project_dir
    os.environ["CLAUDE_SESSION_ID"] = session_id
    if stop_hook_active is None:
        os.environ.pop("CLAUDE_STOP_HOOK_ACTIVE", None)
    else:
        os.environ["CLAUDE_STOP_HOOK_ACTIVE"] = "true" if stop_hook_active else "false"
    if agent_id is None:
        os.environ.pop("CLAUDE_AGENT_ID", None)
    else:
        os.environ["CLAUDE_AGENT_ID"] = agent_id
    if phase is None:
        os.environ.pop("CLAUDE_GATE_PHASE", None)
    else:
        os.environ["CLAUDE_GATE_PHASE"] = phase
    os.environ["DOGWOOD_BIN"] = dogwood_bin or MISSING_DOGWOOD_BIN
    try:
        spec = importlib.util.spec_from_file_location("stop_gate_under_test", SCRIPT_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def run_stop_gate(project_dir, session_id="sess1", stop_hook_active=None, agent_id=None, phase=None,
                  dogwood_bin=None):
    """stop-gate.py を実プロセスとして起動する（`if __name__ == "__main__":` 経路を通す）。"""
    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = project_dir
    env["CLAUDE_SESSION_ID"] = session_id
    if stop_hook_active is None:
        env.pop("CLAUDE_STOP_HOOK_ACTIVE", None)
    else:
        env["CLAUDE_STOP_HOOK_ACTIVE"] = "true" if stop_hook_active else "false"
    if agent_id is None:
        env.pop("CLAUDE_AGENT_ID", None)
    else:
        env["CLAUDE_AGENT_ID"] = agent_id
    if phase is None:
        env.pop("CLAUDE_GATE_PHASE", None)
    else:
        env["CLAUDE_GATE_PHASE"] = phase
    env["DOGWOOD_BIN"] = dogwood_bin or MISSING_DOGWOOD_BIN
    return subprocess.run(
        [sys.executable, SCRIPT_PATH], capture_output=True, text=True, env=env, timeout=60
    )


def write_gate_yaml(project_dir, gate_dict):
    claude_dir = os.path.join(project_dir, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    with open(os.path.join(claude_dir, "gate.yaml"), "w", encoding="utf-8") as fh:
        json.dump(gate_dict, fh)  # JSON は YAML のサブセットなので PyYAML/yq どちらでも読める


def write_changed_files(project_dir, session_id, *rel_paths):
    claude_dir = os.path.join(project_dir, ".claude", ".gate-status")
    os.makedirs(claude_dir, exist_ok=True)
    with open(os.path.join(claude_dir, f"changed_files.{session_id}.txt"), "w") as fh:
        for p in rel_paths:
            fh.write(p + "\n")


def attempts_count(project_dir, session_id):
    path = os.path.join(project_dir, ".claude", ".gate-status", f"gate_attempts.{session_id}.txt")
    with open(path) as fh:
        return fh.read().strip()


def changed_path(project_dir, session_id):
    return os.path.join(project_dir, ".claude", ".gate-status", f"changed_files.{session_id}.txt")


def sidecar_path(project_dir, session_id):
    return os.path.join(project_dir, ".claude", ".gate-status", f"gate_passed.{session_id}.txt")


def pending_path(project_dir, session_id):
    return os.path.join(project_dir, ".claude", ".gate-status", f"gate_pending_checks.{session_id}.json")


def read_pending(project_dir, session_id):
    with open(pending_path(project_dir, session_id)) as fh:
        return json.load(fh)


def write_pending(project_dir, session_id, data):
    claude_dir = os.path.join(project_dir, ".claude", ".gate-status")
    os.makedirs(claude_dir, exist_ok=True)
    with open(pending_path(project_dir, session_id), "w") as fh:
        json.dump(data, fh)


# jq 無し環境をサンドボックスで再現するための symlink 集合。
# reset-gate.sh のフォールバック経路が使う外部コマンド:
#   - bash: subprocess.run(["bash", RESET_GATE_SCRIPT], env=...) の実行体そのもの
#   - cat:  JSON_INPUT=$(cat) / grep,head,sed: session_id 等の抜き出し / rm,find: 状態ファイル掃除
_RESET_GATE_SANDBOX_BINS = ("bash", "cat", "grep", "head", "sed", "rm", "find")
# record-changes.sh のフォールバック経路が使う外部コマンド（上記に加えて mkdir, dirname）。
_RECORD_CHANGES_SANDBOX_BINS = ("bash", "cat", "grep", "head", "sed", "mkdir", "dirname")


@contextlib.contextmanager
def _sandbox_path_without_jq(bins=_RESET_GATE_SANDBOX_BINS):
    """bins だけを symlink したディレクトリを作り、jq は置かない。
    これにより command -v jq が失敗し、フォールバック経路に入る。"""
    with tempfile.TemporaryDirectory() as bin_dir:
        for name in bins:
            src = shutil.which(name)
            if src is None:
                raise RuntimeError(
                    f"サンドボックス構築に必要なコマンドが見つかりません: {name}"
                )
            os.symlink(src, os.path.join(bin_dir, name))
        yield bin_dir


# ---- per_file_dir: "file" / true のルートはマッチしたファイル自身の dirname（純粋関数） ----
class FileRootTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_root_is_dirname_of_the_matched_file(self):
        cases = [
            ("packages/foo/x.go", "packages/foo"),
            ("services/foo/src/utils/helper.py", "services/foo/src/utils"),
            ("pkg/services/chat/x.go", "pkg/services/chat"),
        ]
        for rel_path, expected in cases:
            with self.subTest(rel_path=rel_path):
                self.assertEqual(self.mod.file_root(rel_path), expected)

    def test_file_directly_under_project_root_gives_empty_root(self):
        self.assertEqual(self.mod.file_root("x.py"), "")


# ---- dogwood のトレース行: 複数行のコマンドでも 1 レコード 1 行になること（純粋関数） ----
class TraceLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_cedar_string_escapes_control_characters(self):
        self.assertEqual(self.mod.cedar_string('a\nb\r\tc"\\'), '"a\\nb\\r\\tc\\"\\\\"')

    def test_trace_line_of_multiline_cmd_is_single_line(self):
        rec = {"ts": 1, "name": "all-type-check", "kind": "response",
               "cmd": 'for pkg in packages/*/; do\n  echo "${pkg}"\ndone\nexit $status'}
        line = self.mod.trace_line(rec, self.tmp, 0)
        self.assertNotIn("\n", line)
        self.assertNotIn("\r", line)


# ---- per_file_dir: "pattern_root" のルートが最初の ** の直前で止まること（純粋関数） ----
class GlobMatchRootTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_double_star_root_stops_before_double_star_segment(self):
        cases = [
            ("packages/*/**/*.go", "packages/foo/x.go", "packages/foo"),
            ("services/*/**/*.py", "services/foo/src/utils/helper.py", "services/foo"),
            ("packages/api/**/*.go", "packages/api/internal/x.go", "packages/api"),
        ]
        for pattern, rel_path, expected in cases:
            with self.subTest(pattern=pattern, rel_path=rel_path):
                self.assertEqual(self.mod.glob_match_root(pattern, rel_path), expected)

    def test_pattern_without_double_star_falls_back_to_dirname(self):
        self.assertEqual(
            self.mod.glob_match_root("services/*/*.py", "services/foo/x.py"),
            "services/foo",
        )

    def test_leading_double_star_gives_project_root(self):
        self.assertEqual(self.mod.glob_match_root("**/*.py", "x.py"), "")


# ---- normalize_per_file_dir_mode: per_file_dir の値 -> "file" / "pattern_root" / None ----
class NormalizePerFileDirModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_true_and_file_string_normalize_to_file_mode(self):
        self.assertEqual(self.mod.normalize_per_file_dir_mode(True), "file")
        self.assertEqual(self.mod.normalize_per_file_dir_mode("file"), "file")

    def test_pattern_root_string_normalizes_to_pattern_root_mode(self):
        self.assertEqual(self.mod.normalize_per_file_dir_mode("pattern_root"), "pattern_root")

    def test_invalid_values_return_none(self):
        for value in (False, None, "", "bogus", 1, "File", "PATTERN_ROOT"):
            with self.subTest(value=value):
                self.assertIsNone(self.mod.normalize_per_file_dir_mode(value))


class ComputePerFileRootsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_file_mode_uses_each_files_own_dirname(self):
        mod = self.mod
        pairs = mod.match_patterns(["pkg/**/*.go"])
        matched = [
            "pkg/services/chat/x.go",
            "pkg/services/chat/y_test.go",
            "pkg/domain/user/z.go",
        ]
        roots = mod.compute_per_file_roots("file", pairs, matched)
        self.assertEqual(roots["pkg/services/chat/x.go"], "pkg/services/chat")
        self.assertEqual(roots["pkg/services/chat/y_test.go"], "pkg/services/chat")
        self.assertEqual(roots["pkg/domain/user/z.go"], "pkg/domain/user")

    def test_pattern_root_mode_uses_first_matching_pattern_in_match_order(self):
        mod = self.mod
        pairs = mod.match_patterns(["packages/**/*.go", "packages/api/**/*.go"])
        roots = mod.compute_per_file_roots("pattern_root", pairs, ["packages/api/x.go"])
        self.assertEqual(roots["packages/api/x.go"], "packages")

        pairs_reversed = mod.match_patterns(["packages/api/**/*.go", "packages/**/*.go"])
        roots_reversed = mod.compute_per_file_roots("pattern_root", pairs_reversed, ["packages/api/x.go"])
        self.assertEqual(roots_reversed["packages/api/x.go"], "packages/api")

    def test_pattern_root_mode_dedupes_by_root_across_multiple_files(self):
        mod = self.mod
        pairs = mod.match_patterns(["services/*/**/*.py"])
        matched = ["services/foo/a.py", "services/foo/sub/b.py", "services/bar/c.py"]
        roots = mod.compute_per_file_roots("pattern_root", pairs, matched)
        self.assertEqual(sorted(set(roots.values())), ["services/bar", "services/foo"])


class SummarizeCmdsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_sequential_commands_are_not_joined_with_double_ampersand(self):
        result = self.mod.summarize_cmds(["a", "b", "c"])
        self.assertEqual(result, "a ; b ; c")
        self.assertNotIn("&&", result)

    def test_parallel_block_still_uses_ampersand_inside_parens(self):
        cmds = [{"cmd": "echo a"}, {"parallel": ["echo b", "echo c"]}]
        self.assertEqual(self.mod.summarize_cmds(cmds), "echo a ; (echo b & echo c)")


# ---- rules フェーズ: 単純なルール実行（run_checks 無し = rules フェーズだけで完結） ----
class PerFileDirIntegrationTest(unittest.TestCase):
    """per_file_dir の2モードが、実際にコマンドを実行して意図した cwd で走ることを
    確認する回帰テスト。"""

    def test_file_mode_cwd_is_matched_files_own_directory(self):
        with tempfile.TemporaryDirectory() as proj:
            svc = os.path.join(proj, "pkg", "services", "chat")
            os.makedirs(svc)
            open(os.path.join(svc, "marker.txt"), "w").close()
            open(os.path.join(svc, "x.go"), "w").close()
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "pkg/**/*.go",
                    "per_file_dir": True,
                    "run": ["test -f marker.txt"],
                }]
            })
            write_changed_files(proj, "sess1", "pkg/services/chat/x.go")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            # run_checks が無いので、成功したファイルは CHANGED から完全に消えている
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

    def test_file_mode_files_in_same_directory_share_a_single_run(self):
        """特定リポジトリの回帰: pkg/**/*.go にマッチした同じサービスディレクトリ配下の
        複数ファイル（本体 + _test.go）は、per_file_dir: true（file モード）だと
        そのディレクトリで1回だけ実行される。"""
        with tempfile.TemporaryDirectory() as proj:
            svc = os.path.join(proj, "pkg", "services", "chat")
            os.makedirs(svc)
            open(os.path.join(svc, "x.go"), "w").close()
            open(os.path.join(svc, "y_test.go"), "w").close()
            counter = os.path.join(proj, "run_count.txt")
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "pkg/**/*.go",
                    "per_file_dir": True,
                    "run": [f"echo x >> {counter}"],
                }]
            })
            write_changed_files(
                proj, "sess1",
                "pkg/services/chat/x.go", "pkg/services/chat/y_test.go",
            )
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            with open(counter) as fh:
                lines = fh.read().splitlines()
            self.assertEqual(len(lines), 1)

    def test_pattern_root_mode_cwd_is_service_root_not_leaf_directory(self):
        """pnpm workspace / pyproject.toml のようにパッケージルートでまとめて実行
        したい場合は per_file_dir: "pattern_root" を使う（file モードとは逆に、
        ネストしたファイルを触ってもパターンの ** 直前のディレクトリで実行される）。"""
        with tempfile.TemporaryDirectory() as proj:
            svc = os.path.join(proj, "services", "foo")
            leaf = os.path.join(svc, "src", "utils")
            os.makedirs(leaf)
            open(os.path.join(svc, "pyproject.toml"), "w").close()
            open(os.path.join(leaf, "helper.py"), "w").close()
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "services/*/**/*.py",
                    "per_file_dir": "pattern_root",
                    "run": ["test -f pyproject.toml"],
                }]
            })
            write_changed_files(proj, "sess1", "services/foo/src/utils/helper.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))


class ChangedFilesEnvTest(unittest.TestCase):
    """run のコマンドへ、そのとき対象になっているファイルが CLAUDE_GATE_FILES で渡る。"""

    def test_rule_run_receives_matched_files(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "app"))
            for name in ("b.rb", "a.rb"):
                open(os.path.join(proj, "app", name), "w").close()
            open(os.path.join(proj, "app", "ignored.txt"), "w").close()
            out = os.path.join(proj, "files.txt")
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "app/**/*.rb",
                    "run": [f'printf "%s\\n" "$CLAUDE_GATE_FILES" > {out}'],
                }]
            })
            write_changed_files(
                proj, "sess1",
                "app/b.rb", "app/a.rb", "app/ignored.txt", "app/b.rb",
            )
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)
            with open(out) as fh:
                self.assertEqual(fh.read().strip(), "app/a.rb app/b.rb")

    def test_per_file_dir_run_receives_only_that_roots_files(self):
        with tempfile.TemporaryDirectory() as proj:
            for d in ("chat", "user"):
                os.makedirs(os.path.join(proj, "pkg", d))
                open(os.path.join(proj, "pkg", d, "x.go"), "w").close()
            out = os.path.join(proj, "files.txt")
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "pkg/**/*.go",
                    "per_file_dir": True,
                    "run": [f'printf "%s\\n" "$CLAUDE_GATE_FILES" >> {out}'],
                }]
            })
            write_changed_files(proj, "sess1", "pkg/chat/x.go", "pkg/user/x.go")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)
            with open(out) as fh:
                self.assertEqual(
                    sorted(fh.read().splitlines()), ["pkg/chat/x.go", "pkg/user/x.go"])

    def test_eval_set_recovers_paths_with_spaces(self):
        """値は shlex 引用済みなので、eval set -- で受けると空白入りパスも1引数に戻る
        （素の $CLAUDE_GATE_FILES は単語分割されるため空白入りパスには使えない）。"""
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "app"))
            open(os.path.join(proj, "app", "a b.rb"), "w").close()
            out = os.path.join(proj, "files.txt")
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "app/**/*.rb",
                    "run": [f'eval "set -- $CLAUDE_GATE_FILES"; for f in "$@"; do echo "$f" >> {out}; done'],
                }]
            })
            write_changed_files(proj, "sess1", "app/a b.rb")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)
            with open(out) as fh:
                self.assertEqual(fh.read().splitlines(), ["app/a b.rb"])

    def test_consistency_check_run_receives_reserving_files(self):
        with tempfile.TemporaryDirectory() as proj:
            out = os.path.join(proj, "files.txt")
            _setup_reserved_check_project(
                proj, "sess1", [f'printf "%s\\n" "$CLAUDE_GATE_FILES" > {out}'])
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules").main(), 0)
            self.assertEqual(load_stop_gate(proj, "sess1", phase="checks").main(), 0)
            with open(out) as fh:
                self.assertEqual(fh.read().strip(), "x.py")


class InvalidPerFileDirValueTest(unittest.TestCase):
    def test_invalid_value_fails_the_rule_instead_of_silently_ignoring(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "**/*.py", "per_file_dir": "bogus", "run": ["echo hi"]}]
            })
            write_changed_files(proj, "sess1", "x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            # rules フェーズの失敗は会話をブロックしないが、exit 2 で stderr 通知される
            self.assertEqual(mod.main(), 2)


class MissingCwdTest(unittest.TestCase):
    def test_dir_rule_with_missing_directory_is_skipped_not_crashed(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "ghost/**/*.py", "dir": "ghost", "run": ["echo hi"]}]
            })
            write_changed_files(proj, "sess1", "ghost/x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)

    def test_per_file_dir_with_missing_root_is_skipped_not_crashed(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "ghost/*/**/*.py", "per_file_dir": True, "run": ["echo hi"],
                }]
            })
            write_changed_files(proj, "sess1", "ghost/foo/bar.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)

    def test_consistency_check_with_missing_dir_is_skipped_not_crashed(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{
                    "match": "**/*.py", "run": ["true"], "run_checks": ["ghost-check"],
                }],
                "consistency_checks": [
                    {"name": "ghost-check", "dir": "ghost", "run": ["echo hi"]},
                ],
            })
            write_changed_files(proj, "sess1", "x.py")
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)
            checks_mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(checks_mod.main(), 0)


class StatusLinesTest(unittest.TestCase):
    """通過・スキップ時にも 1 行ずつ出す（通ったのか実行されなかったのか区別するため）。
    形式: `[gate] ok: <label> $ <cmd> (<秒>s)` / `[gate] skip: ...` / `[gate] fail: ...`。"""

    def _message(self, r):
        return json.loads(r.stdout)["systemMessage"]

    def test_rules_phase_prints_ok_line_with_label_cmd_and_seconds(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "sub"))
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "dir": "sub", "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = run_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(r.returncode, 0)
            self.assertRegex(self._message(r), r"\[gate\] ok: sub \$ echo hi \(\d+\.\ds\)")

    def test_ok_line_is_printed_for_each_parallel_command(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [
                {"parallel": ["echo aaa", {"cmd": "echo bbb", "name": "second"}]}]}]})
            write_changed_files(proj, "sess1", "x.py")
            msg = self._message(run_stop_gate(proj, "sess1", phase="rules"))
            self.assertRegex(msg, r"\[gate\] ok: \. \$ echo aaa \(")
            self.assertRegex(msg, r"\[gate\] ok: \. \$ echo bbb \(")

    def test_multiline_cmd_is_collapsed_to_one_line(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["echo first\necho second"]}]})
            write_changed_files(proj, "sess1", "x.py")
            msg = self._message(run_stop_gate(proj, "sess1", phase="rules"))
            ok_lines = [l for l in msg.splitlines() if l.startswith("[gate] ok:")]
            self.assertEqual(len(ok_lines), 1)
            self.assertIn("echo first ...", ok_lines[0])
            self.assertNotIn("echo second", msg)

    def test_file_matching_no_rule_is_reported_as_skipped(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "x.py", "notes.txt")
            msg = self._message(run_stop_gate(proj, "sess1", phase="rules"))
            skip_lines = [l for l in msg.splitlines() if l.startswith("[gate] skip:")]
            self.assertEqual(len(skip_lines), 1)
            self.assertRegex(skip_lines[0], r"notes\.txt.*どのルールにもマッチしません")
            self.assertNotIn("x.py", skip_lines[0])

    def test_only_unmatched_files_still_prints_a_skip_line(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "notes.txt")
            r = run_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(r.returncode, 0)
            self.assertIn("[gate] skip:", self._message(r))

    def test_missing_cwd_is_reported_as_skipped(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "dir": "ghost", "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "x.py")
            msg = self._message(run_stop_gate(proj, "sess1", phase="rules"))
            self.assertRegex(msg, r"\[gate\] skip: ghost \$ echo hi .*cwd")

    def test_policy_skip_is_reported_as_skipped(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _ = write_fake_dogwood(os.path.join(proj, "bin"), verdict="deny")
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = run_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertRegex(self._message(r), r"\[gate\] skip: \. \$ echo hi .*ポリシー")

    def test_failure_keeps_detail_and_adds_fail_and_ok_lines_on_stderr(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [
                "echo passed-cmd", "echo boom-detail; exit 1"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = run_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(r.returncode, 2)
            self.assertRegex(r.stderr, r"\[gate\] ok: \. \$ echo passed-cmd \(")
            self.assertRegex(r.stderr, r"\[gate\] fail: \. \$ echo boom-detail; exit 1 \(")
            self.assertIn("boom-detail", r.stderr)

    def test_checks_phase_prints_ok_line(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "**/*.py", "run": ["echo r"], "run_checks": ["all"]}],
                "consistency_checks": [{"name": "all", "run": ["echo whole"]}],
            })
            write_changed_files(proj, "sess1", "x.py")
            run_stop_gate(proj, "sess1", phase="rules")
            r = run_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(r.returncode, 0)
            self.assertRegex(self._message(r), r"\[gate\] ok: check:all \$ echo whole \(\d+\.\ds\)")

    def test_files_env_reaches_the_command(self):
        """CLAUDE_GATE_FILES 付きでコマンドが組み立てられる（パッケージ相対への変換材料になる）。"""
        with tempfile.TemporaryDirectory() as proj:
            out = os.path.join(proj, "files.out")
            os.makedirs(os.path.join(proj, "packages", "app"))
            write_gate_yaml(proj, {"rules": [{
                "match": "packages/app/**/*.ts", "dir": "packages/app",
                "run": [f'echo "$CLAUDE_GATE_FILES" > {out}']}]})
            write_changed_files(proj, "sess1", "packages/app/src/a.ts", "packages/app/src/b.ts")
            run_stop_gate(proj, "sess1", phase="rules")
            with open(out) as fh:
                self.assertEqual(fh.read().strip(), "packages/app/src/a.ts packages/app/src/b.ts")


class InternalErrorSafetyNetTest(unittest.TestCase):
    """main() を包む try/except。__main__ 経路を通す必要があるので subprocess で。
    match が不正な設定は rules フェーズでの matching 時にしか評価されないため、
    このテストは phase=rules で走らせる。"""

    def test_unexpected_exception_is_caught_exit_zero_with_system_message(self):
        with tempfile.TemporaryDirectory() as proj:
            # match が文字列/リストではない不正な設定 -> compile 時に TypeError を誘発する
            write_gate_yaml(proj, {"rules": [{"match": 123, "run": ["echo hi"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = run_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(r.returncode, 0)
            self.assertIn("systemMessage", r.stdout)
            self.assertIn("内部エラー", r.stdout)
            self.assertIn("Traceback", r.stderr)


class YamlParserMissingTest(unittest.TestCase):
    def _patch_no_parser(self, mod):
        mod.which = lambda cmd: None
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "yaml":
                raise ImportError("forced for test")
            return real_import(name, *args, **kwargs)

        builtins.__import__ = fake_import
        return real_import

    def test_load_action_returns_sentinel_when_no_parser_available(self):
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1")
            gate_path = os.path.join(proj, "gate.yaml")
            with open(gate_path, "w") as fh:
                fh.write("rules: []\n")
            real_import = self._patch_no_parser(mod)
            try:
                result = mod.load_action(gate_path)
            finally:
                builtins.__import__ = real_import
            self.assertIsInstance(result, mod._YamlUnavailable)

    def test_rules_phase_emits_system_message_when_yaml_parser_missing(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            write_changed_files(proj, "sess1", "x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            real_import = self._patch_no_parser(mod)
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    rc = mod.main()
            finally:
                builtins.__import__ = real_import
            self.assertEqual(rc, 0)
            self.assertIn("systemMessage", buf.getvalue())
            self.assertIn("YAML", buf.getvalue())
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

    def test_checks_phase_requeues_pending_to_changed_when_yaml_parser_missing(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            write_pending(proj, "sess1", {proj: {"chk": ["x.py"]}})
            mod = load_stop_gate(proj, "sess1", phase="checks")
            real_import = self._patch_no_parser(mod)
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    rc = mod.main()
            finally:
                builtins.__import__ = real_import
            self.assertEqual(rc, 0)
            self.assertIn("YAML", buf.getvalue())
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))
            with open(changed_path(proj, "sess1")) as fh:
                self.assertEqual(fh.read().split(), ["x.py"])


class GateYmlTypoTest(unittest.TestCase):
    def test_python_warns_when_only_yml_extension_present(self):
        with tempfile.TemporaryDirectory() as proj:
            claude_dir = os.path.join(proj, ".claude")
            os.makedirs(claude_dir)
            open(os.path.join(claude_dir, "gate.yml"), "w").close()
            r = run_stop_gate(proj, "sess1")
            self.assertEqual(r.returncode, 0)
            self.assertIn("systemMessage", r.stdout)
            self.assertIn("gate.yml", r.stdout)

    def test_no_warning_when_neither_file_present(self):
        with tempfile.TemporaryDirectory() as proj:
            r = run_stop_gate(proj, "sess1")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout.strip(), "")


class StopTestGateShTest(unittest.TestCase):
    """stop-test-gate.sh（bash ラッパ）の統合テスト。第1引数がフェーズ（rules|checks）。"""

    def _run(self, project_dir, payload, args=None, env_overrides=None):
        env = dict(os.environ)
        env["CLAUDE_PROJECT_DIR"] = project_dir
        env["DOGWOOD_BIN"] = MISSING_DOGWOOD_BIN
        if env_overrides:
            env.update(env_overrides)
        return subprocess.run(
            ["bash", WRAPPER_PATH, *(args or [])], input=json.dumps(payload),
            capture_output=True, text=True, env=env, timeout=30,
        )

    def test_warns_on_yml_typo_without_crashing(self):
        with tempfile.TemporaryDirectory() as proj:
            claude_dir = os.path.join(proj, ".claude")
            os.makedirs(claude_dir)
            open(os.path.join(claude_dir, "gate.yml"), "w").close()
            r = self._run(proj, {"session_id": "sess1"})
            self.assertEqual(r.returncode, 0)
            self.assertIn("gate.yml", r.stdout)

    def test_exits_silently_when_neither_gate_file_exists(self):
        with tempfile.TemporaryDirectory() as proj:
            r = self._run(proj, {"session_id": "sess1"})
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout.strip(), "")

    def test_first_arg_selects_rules_phase(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_GATE_PHASE')=='rules' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = self._run(proj, {"session_id": "sess1"}, args=["rules"])
            self.assertEqual(r.returncode, 0)

    def test_no_arg_defaults_to_checks_phase(self):
        with tempfile.TemporaryDirectory() as proj:
            # checks フェーズは PENDING が無ければ何もせず、rule の run は一切実行されない。
            # ここでは環境変数を直接確認するため、rules フェーズなら実行されるはずの
            # コマンドが「実行されない」ことをもって checks がデフォルトだと確認する。
            marker = os.path.join(proj, "ran.marker")
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [f"touch {marker}"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = self._run(proj, {"session_id": "sess1"})
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(marker))

    def test_script_dir_is_used_instead_of_home_hardcode(self):
        # $HOME/.claude/hooks 配下の stop-gate.py 固定ではなく、ラッパ自身と同じディレクトリの
        # stop-gate.py を呼ぶことを、$HOME に別の(壊れた) stop-gate.py を置いて確認する。
        with tempfile.TemporaryDirectory() as proj, tempfile.TemporaryDirectory() as fake_home:
            fake_hooks = os.path.join(fake_home, ".claude", "hooks")
            os.makedirs(fake_hooks)
            with open(os.path.join(fake_hooks, "stop-gate.py"), "w") as fh:
                fh.write("import sys\nsys.exit(99)\n")
            write_gate_yaml(proj, {"rules": []})
            r = self._run(proj, {"session_id": "sess1"}, env_overrides={"HOME": fake_home})
            self.assertNotEqual(r.returncode, 99)

    def test_stop_hook_active_true_is_threaded_through_to_python_env(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_STOP_HOOK_ACTIVE')=='true' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = self._run(proj, {"session_id": "sess1", "stop_hook_active": True}, args=["rules"])
            self.assertEqual(r.returncode, 0)

    def test_stop_hook_active_false_is_threaded_through_to_python_env(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_STOP_HOOK_ACTIVE')=='false' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = self._run(proj, {"session_id": "sess1"}, args=["rules"])  # stop_hook_active フィールド無し
            self.assertEqual(r.returncode, 0)

    def test_falls_back_to_grep_when_jq_missing(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_STOP_HOOK_ACTIVE')=='true' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1", "x.py")
            no_jq_dir = tempfile.mkdtemp()
            for name in ("bash", "python3", "grep", "sed", "cat", "head", "dirname", "yq"):
                for candidate in ("/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"):
                    src = os.path.join(candidate, name)
                    if os.path.exists(src):
                        os.symlink(src, os.path.join(no_jq_dir, name))
                        break
            r = self._run(
                proj, {"session_id": "sess1", "stop_hook_active": True}, args=["rules"],
                env_overrides={"PATH": no_jq_dir},
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_agent_id_is_threaded_through_to_python_env(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_AGENT_ID')=='agent1' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1--agent1", "x.py")
            r = self._run(proj, {"session_id": "sess1", "agent_id": "agent1"}, args=["rules"])
            self.assertEqual(r.returncode, 0)

    def test_agent_id_absent_leaves_env_var_unset(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if 'CLAUDE_AGENT_ID' not in os.environ else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = self._run(proj, {"session_id": "sess1"}, args=["rules"])
            self.assertEqual(r.returncode, 0)

    def test_agent_id_threaded_through_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            check_cmd = (
                f"{sys.executable} -c "
                "\"import os,sys; sys.exit(0 if os.environ.get('CLAUDE_AGENT_ID')=='agent1' else 1)\""
            )
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": [check_cmd]}]})
            write_changed_files(proj, "sess1--agent1", "x.py")
            no_jq_dir = tempfile.mkdtemp()
            for name in ("bash", "python3", "grep", "sed", "cat", "head", "dirname", "yq"):
                for candidate in ("/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"):
                    src = os.path.join(candidate, name)
                    if os.path.exists(src):
                        os.symlink(src, os.path.join(no_jq_dir, name))
                        break
            r = self._run(
                proj, {"session_id": "sess1", "agent_id": "agent1"}, args=["rules"],
                env_overrides={"PATH": no_jq_dir},
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class RecordChangesShTest(unittest.TestCase):
    """record-changes.sh（PostToolUse hook）の統合テスト。agent_id の有無で
    書き込み先メモファイルが変わることを確認する。"""

    def _run(self, project_dir, payload, path_override=None):
        env = dict(os.environ)
        env["CLAUDE_PROJECT_DIR"] = project_dir
        if path_override is not None:
            env["PATH"] = path_override
        return subprocess.run(
            ["bash", RECORD_CHANGES_SCRIPT], input=json.dumps(payload),
            capture_output=True, text=True, env=env, timeout=30,
        )

    def _memo_path(self, project_dir, state_id):
        return os.path.join(project_dir, ".claude", ".gate-status", f"changed_files.{state_id}.txt")

    def test_agent_id_present_uses_suffixed_memo(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            payload = {"session_id": "sess1", "agent_id": "agent1",
                       "tool_input": {"file_path": "x.py"}}
            r = self._run(proj, payload)
            self.assertEqual(r.returncode, 0)
            with open(self._memo_path(proj, "sess1--agent1")) as fh:
                self.assertEqual(fh.read().strip(), "x.py")
            self.assertFalse(os.path.exists(self._memo_path(proj, "sess1")))

    def test_agent_id_absent_uses_plain_memo(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            payload = {"session_id": "sess1", "tool_input": {"file_path": "x.py"}}
            r = self._run(proj, payload)
            self.assertEqual(r.returncode, 0)
            with open(self._memo_path(proj, "sess1")) as fh:
                self.assertEqual(fh.read().strip(), "x.py")

    def test_agent_id_present_uses_suffixed_memo_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            with _sandbox_path_without_jq(_RECORD_CHANGES_SANDBOX_BINS) as bin_dir:
                payload = {"session_id": "sess1", "agent_id": "agent1",
                           "tool_input": {"file_path": "x.py"}}
                r = self._run(proj, payload, path_override=bin_dir)
            self.assertEqual(r.returncode, 0)
            with open(self._memo_path(proj, "sess1--agent1")) as fh:
                self.assertEqual(fh.read().strip(), "x.py")

    def test_agent_id_absent_uses_plain_memo_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            with _sandbox_path_without_jq(_RECORD_CHANGES_SANDBOX_BINS) as bin_dir:
                payload = {"session_id": "sess1", "tool_input": {"file_path": "x.py"}}
                r = self._run(proj, payload, path_override=bin_dir)
            self.assertEqual(r.returncode, 0)
            with open(self._memo_path(proj, "sess1")) as fh:
                self.assertEqual(fh.read().strip(), "x.py")


def run_reset_gate(project_dir, session_id="sess1", source="startup", use_jq=True):
    payload = {"session_id": session_id}
    if source is not None:
        payload["source"] = source
    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = project_dir
    with contextlib.ExitStack() as stack:
        if not use_jq:
            bin_dir = stack.enter_context(_sandbox_path_without_jq())
            env["PATH"] = bin_dir
            assert shutil.which("jq", path=env["PATH"]) is None, "jq を PATH から除外できていない"
        return subprocess.run(
            ["bash", RESET_GATE_SCRIPT],
            input=json.dumps(payload),
            env=env,
            capture_output=True,
            text=True,
            cwd=project_dir,
            timeout=30,
        )


def make_reset_gate_state_files(project_dir, session_id):
    claude_dir = os.path.join(project_dir, ".claude", ".gate-status")
    os.makedirs(claude_dir, exist_ok=True)
    changed = os.path.join(claude_dir, f"changed_files.{session_id}.txt")
    attempts = os.path.join(claude_dir, f"gate_attempts.{session_id}.txt")
    sidecar = os.path.join(claude_dir, f"gate_passed.{session_id}.txt")
    pending = os.path.join(claude_dir, f"gate_pending_checks.{session_id}.json")
    with open(changed, "w") as fh: fh.write("a.py\n")
    with open(attempts, "w") as fh: fh.write("1\n")
    with open(sidecar, "w") as fh: fh.write("b.py\n")
    with open(pending, "w") as fh: fh.write('{"go-build": ["c.py"]}\n')
    return changed, attempts, sidecar, pending


class ResetGateSourceTest(unittest.TestCase):
    """SessionStart の source（startup/resume/clear/compact/未知/未取得）に応じて
    セッション状態ファイルを消すかどうかを切り替える。resume/compact や未知の
    source では消さない（安全側）。PENDING（gate_pending_checks.*.json）も対象に含む。"""

    def test_deletes_state_on_startup(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout, "")
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_deletes_state_on_clear(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="clear")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_keeps_state_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout, "")
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_keeps_state_on_compact(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="compact")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_keeps_state_when_source_missing(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source=None)
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_keeps_state_on_unknown_source(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="something-new")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_deletes_state_on_startup_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="startup", use_jq=False)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout, "")
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_keeps_state_on_resume_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="resume", use_jq=False)
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_deletes_agent_suffixed_state_on_startup(self):
        # SubagentStop 経由の状態ファイル（changed_files.<session>--<agent>.txt 等）も
        # 起動時のクリーンアップ対象に含まれる。payload の session_id はメインの
        # セッションIDのみ（agent_id は含まない）。
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_deletes_agent_suffixed_state_on_clear(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="clear")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_keeps_agent_suffixed_state_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_deletes_agent_suffixed_state_on_startup_without_jq(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_reset_gate_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="startup", use_jq=False)
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_always_prunes_stale_sessions_regardless_of_source(self):
        # current session (resume, 消えないはず) とは別に、24h超前の古いセッションの
        # 残骸は source に関係なく掃除される。
        with tempfile.TemporaryDirectory() as proj:
            cur_files = make_reset_gate_state_files(proj, "sess-current")
            stale_files = make_reset_gate_state_files(proj, "sess-stale")
            old_time = 1000  # 十分古い mtime/atime（1970年付近）
            for f in stale_files:
                os.utime(f, (old_time, old_time))

            r = run_reset_gate(proj, session_id="sess-current", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in cur_files:
                self.assertTrue(os.path.exists(f))
            for f in stale_files:
                self.assertFalse(os.path.exists(f))


LEGACY_STATE_NAMES = (
    "changed_files.{sid}.txt", "gate_attempts.{sid}.txt", "gate_passed.{sid}.txt",
    "gate_pending_checks.{sid}.json", "gate_trace.{sid}.jsonl", "gate_deferred.{sid}.json",
    "gate_push_verified.{sid}.txt", "feedback_gate_attempts.{sid}.txt",
)


def make_legacy_state_files(project_dir, session_id):
    """移行前の置き場所（.claude/ 直下と .claude/hooks/logs/<state_id>/）に残った状態ファイル。"""
    claude_dir = os.path.join(project_dir, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    paths = []
    for name in LEGACY_STATE_NAMES:
        p = os.path.join(claude_dir, name.format(sid=session_id))
        with open(p, "w") as fh: fh.write("x\n")
        paths.append(p)
    log_dir = os.path.join(claude_dir, "hooks", "logs", session_id)
    os.makedirs(log_dir, exist_ok=True)
    log = os.path.join(log_dir, "cmd.1.log")
    with open(log, "w") as fh: fh.write("x\n")
    paths.append(log)
    return paths


class ResetGateLegacyPathTest(unittest.TestCase):
    """移行前の旧パスに残った状態ファイルも reset-gate.sh が同じ条件で掃除する。"""

    def test_deletes_legacy_state_on_startup(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_legacy_state_files(proj, "sess1")
            files += make_legacy_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f), f)

    def test_keeps_legacy_state_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_legacy_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f), f)

    def test_prunes_stale_legacy_state_regardless_of_source(self):
        with tempfile.TemporaryDirectory() as proj:
            stale = make_legacy_state_files(proj, "sess-stale")
            for f in stale:
                os.utime(f, (1000, 1000))
            os.utime(os.path.dirname(stale[-1]), (1000, 1000))
            r = run_reset_gate(proj, session_id="sess-current", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in stale:
                self.assertFalse(os.path.exists(f), f)

    def test_does_not_touch_gate_yaml(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": []})
            run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertTrue(os.path.exists(os.path.join(proj, ".claude", "gate.yaml")))


def make_feedback_attempts_file(project_dir, session_id):
    claude_dir = os.path.join(project_dir, ".claude", ".gate-status")
    os.makedirs(claude_dir, exist_ok=True)
    path = os.path.join(claude_dir, f"feedback_gate_attempts.{session_id}.txt")
    with open(path, "w") as fh:
        fh.write("1\n")
    return path


class ResetGateFeedbackAttemptsTest(unittest.TestCase):
    """feedback-stop-check.py が書く feedback_gate_attempts.<session>[--<agent>].txt も
    reset-gate.sh の掃除対象に含まれる。"""

    def test_deletes_feedback_attempts_on_startup(self):
        with tempfile.TemporaryDirectory() as proj:
            path = make_feedback_attempts_file(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(path))

    def test_deletes_feedback_attempts_on_clear(self):
        with tempfile.TemporaryDirectory() as proj:
            path = make_feedback_attempts_file(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="clear")
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(path))

    def test_keeps_feedback_attempts_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            path = make_feedback_attempts_file(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(path))

    def test_deletes_agent_suffixed_feedback_attempts_on_startup(self):
        with tempfile.TemporaryDirectory() as proj:
            path = make_feedback_attempts_file(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(path))

    def test_keeps_agent_suffixed_feedback_attempts_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            path = make_feedback_attempts_file(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(path))

    def test_prunes_stale_feedback_attempts_regardless_of_source(self):
        with tempfile.TemporaryDirectory() as proj:
            cur = make_feedback_attempts_file(proj, "sess-current")
            stale = make_feedback_attempts_file(proj, "sess-stale")
            os.utime(stale, (1000, 1000))
            r = run_reset_gate(proj, session_id="sess-current", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(cur))
            self.assertFalse(os.path.exists(stale))


# ---- 二相構造の核: rules フェーズの予約 <-> checks フェーズの消費 ----
def _setup_reserved_check_project(proj, session_id, check_run, extra_check=None):
    """"x.py" にマッチするルールが consistency_check "chk" を予約する構成を作る。
    check_run は "chk" の run コマンド列。extra_check を渡すと、参照されない
    もう1つの consistency_check "chk-unused" も定義に加える（予約されないことの確認用）。"""
    checks = [{"name": "chk", "run": check_run}]
    if extra_check:
        checks.append(extra_check)
    write_gate_yaml(proj, {
        "rules": [{"match": "**/*.py", "run": ["true"], "run_checks": ["chk"]}],
        "consistency_checks": checks,
    })
    write_changed_files(proj, session_id, "x.py")


class RulesPhaseDoesNotRunChecksTest(unittest.TestCase):
    def test_rules_phase_does_not_execute_consistency_checks(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "chk.marker")
            _setup_reserved_check_project(proj, "sess1", [f"touch {marker}"])
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(marker))


class RulesPhasePersistsReservationTest(unittest.TestCase):
    def test_reservation_is_written_to_pending_file(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["true"])
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            data = read_pending(proj, "sess1")
            self.assertEqual(data, {proj: {"chk": ["x.py"]}})

    def test_reservation_accumulates_across_multiple_rules_phase_runs(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "**/*.py", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [{"name": "chk", "run": ["true"]}],
            })
            write_changed_files(proj, "sess1", "a.py")
            mod1 = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod1.main(), 0)

            write_changed_files(proj, "sess1", "b.py")
            mod2 = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod2.main(), 0)

            data = read_pending(proj, "sess1")
            self.assertEqual(data, {proj: {"chk": ["a.py", "b.py"]}})

    def test_matched_file_moves_from_changed_to_sidecar_pending_confirmation(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["true"])
            mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))
            with open(sidecar_path(proj, "sess1")) as fh:
                self.assertEqual(fh.read().split(), ["x.py"])


class ChecksPhaseRunsOnlyReservedTest(unittest.TestCase):
    def test_only_referenced_check_runs(self):
        with tempfile.TemporaryDirectory() as proj:
            marker_used = os.path.join(proj, "used.marker")
            marker_unused = os.path.join(proj, "unused.marker")
            _setup_reserved_check_project(
                proj, "sess1", [f"touch {marker_used}"],
                extra_check={"name": "chk-unused", "run": [f"touch {marker_unused}"]},
            )
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            checks_mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(checks_mod.main(), 0)
            self.assertTrue(os.path.exists(marker_used))
            self.assertFalse(os.path.exists(marker_unused))

    def test_success_confirms_and_clears_sidecar_and_pending(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["true"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            checks_mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(checks_mod.main(), 0)
            self.assertFalse(os.path.exists(sidecar_path(proj, "sess1")))
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))


class ChecksPhaseNoopWhenEmptyTest(unittest.TestCase):
    def test_no_pending_file_is_a_noop(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [], "consistency_checks": []})
            mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(
                os.path.join(proj, ".claude", ".gate-status", "gate_attempts.sess1.txt")))

    def test_empty_pending_object_is_removed_and_is_a_noop(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [], "consistency_checks": []})
            write_pending(proj, "sess1", {})
            mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))


class PendingRootIsolationTest(unittest.TestCase):
    """同名の consistency_check がメインとワークツリーの双方にあっても、
    checks フェーズはそれぞれ自分のルートの定義（cwd・run）で実行し、混ざらない。"""

    def test_same_named_check_runs_independently_per_root(self):
        with tempfile.TemporaryDirectory() as proj:
            main_marker = os.path.join(proj, "main_chk.marker")
            os.makedirs(os.path.join(proj, "docs"))
            write_gate_yaml(proj, {
                "rules": [{"match": "docs/*.md", "dir": "docs", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [{"name": "chk", "run": [f"touch {main_marker}"]}],
            })

            wt = os.path.join(proj, ".claude", "worktrees", "agent-a1")
            pkg_dir = os.path.join(wt, "pkg")
            os.makedirs(pkg_dir)
            wt_marker = os.path.join(wt, "wt_chk.marker")
            write_gate_yaml(wt, {
                "rules": [{"match": "pkg/*.go", "dir": "pkg", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [{"name": "chk", "run": [f"touch {wt_marker}"]}],
            })

            abs_file = os.path.join(wt, "pkg", "foo.go")
            write_changed_files(proj, "sess1", "docs/readme.md", abs_file)

            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)
            data = read_pending(proj, "sess1")
            self.assertEqual(set(data.keys()), {proj, wt})
            self.assertEqual(data[proj], {"chk": ["docs/readme.md"]})
            self.assertEqual(data[wt], {"chk": [abs_file]})

            checks_mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(checks_mod.main(), 0)
            self.assertTrue(os.path.exists(main_marker))
            self.assertTrue(os.path.exists(wt_marker))

    def test_only_root_with_reservation_runs_its_check(self):
        # メインの "chk" だけが予約され、ワークツリー側の同名 "chk" は
        # 一度も参照されないので実行されない。
        with tempfile.TemporaryDirectory() as proj:
            main_marker = os.path.join(proj, "main_chk.marker")
            os.makedirs(os.path.join(proj, "docs"))
            write_gate_yaml(proj, {
                "rules": [{"match": "docs/*.md", "dir": "docs", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [{"name": "chk", "run": [f"touch {main_marker}"]}],
            })

            wt = os.path.join(proj, ".claude", "worktrees", "agent-a2")
            os.makedirs(wt)
            wt_marker = os.path.join(wt, "wt_chk.marker")
            write_gate_yaml(wt, {
                "rules": [],
                "consistency_checks": [{"name": "chk", "run": [f"touch {wt_marker}"]}],
            })

            write_changed_files(proj, "sess1", "docs/readme.md")

            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)
            data = read_pending(proj, "sess1")
            self.assertEqual(set(data.keys()), {proj})

            checks_mod = load_stop_gate(proj, "sess1", phase="checks")
            self.assertEqual(checks_mod.main(), 0)
            self.assertTrue(os.path.exists(main_marker))
            self.assertFalse(os.path.exists(wt_marker))


class PendingCleanupTest(unittest.TestCase):
    def test_cleanup_removes_pending_file(self):
        with tempfile.TemporaryDirectory() as proj:
            write_pending(proj, "sess1", {proj: {"chk": ["x.py"]}})
            mod = load_stop_gate(proj, "sess1")
            self.assertTrue(os.path.exists(pending_path(proj, "sess1")))
            mod.cleanup()
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))

    def test_cleanup_only_count_and_pending_keeps_changed_and_sidecar(self):
        with tempfile.TemporaryDirectory() as proj:
            write_changed_files(proj, "sess1", "a.py")
            write_pending(proj, "sess1", {proj: {"chk": ["x.py"]}})
            mod = load_stop_gate(proj, "sess1")
            with open(os.path.join(proj, ".claude", ".gate-status", "gate_attempts.sess1.txt"), "w") as fh:
                fh.write("3")
            mod.cleanup(only=(mod.COUNT, mod.PENDING))
            self.assertFalse(os.path.exists(mod.COUNT))
            self.assertFalse(os.path.exists(mod.PENDING))
            self.assertTrue(os.path.exists(mod.CHANGED))

    def test_reset_gate_removes_pending_files_including_agent_suffixed(self):
        with tempfile.TemporaryDirectory() as proj:
            write_pending(proj, "sess1", {proj: {"chk": ["x.py"]}})
            write_pending(proj, "sess1--agent1", {proj: {"chk": ["y.py"]}})
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))
            self.assertFalse(os.path.exists(pending_path(proj, "sess1--agent1")))

    def test_reset_gate_keeps_pending_file_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            write_pending(proj, "sess1", {proj: {"chk": ["x.py"]}})
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(pending_path(proj, "sess1")))

    def test_reset_gate_prunes_stale_pending_file(self):
        with tempfile.TemporaryDirectory() as proj:
            write_pending(proj, "sess-stale", {proj: {"chk": ["x.py"]}})
            path = pending_path(proj, "sess-stale")
            os.utime(path, (1000, 1000))
            r = run_reset_gate(proj, session_id="sess-current", source="resume")
            self.assertEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(path))


class ChecksPhaseMaxAttemptsRequeuesToChangedTest(unittest.TestCase):
    """checks フェーズが MAX_ATTEMPTS 回連続失敗したら、対象ファイルを SIDECAR から
    取り除いて CHANGED へ戻す（次の編集で rules フェーズが再度拾えるようにする保険）。
    これは dff448e 時点での「cleanup(only=(COUNT,)) で CHANGED は残す」という保険の
    二相構造版であり、絶対に壊してはいけない。"""

    def test_max_attempts_requeues_and_keeps_changed_removes_count_and_pending(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)
            self.assertTrue(os.path.exists(sidecar_path(proj, "sess1")))
            self.assertTrue(os.path.exists(pending_path(proj, "sess1")))
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

            r = None
            for i in range(5):
                r = run_stop_gate(proj, "sess1", stop_hook_active=(i > 0), phase="checks")
            self.assertEqual(r.returncode, 0)
            self.assertIn("systemMessage", r.stdout)
            self.assertIn("未検証のまま CHANGED へ戻しました", r.stdout)
            self.assertIn("手動で確認してください", r.stdout)
            self.assertIn("reset-gate.sh", r.stdout)

            self.assertFalse(os.path.exists(
                os.path.join(proj, ".claude", ".gate-status", "gate_attempts.sess1.txt")))
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))
            self.assertFalse(os.path.exists(sidecar_path(proj, "sess1")))
            with open(changed_path(proj, "sess1")) as fh:
                self.assertEqual(fh.read().split(), ["x.py"])

    def test_attempts_accumulate_across_checks_phase_retries(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = None
            for _ in range(4):
                r = run_stop_gate(proj, "sess1", stop_hook_active=True, phase="checks")
            self.assertEqual(r.returncode, 2)
            self.assertEqual(attempts_count(proj, "sess1"), "4")

    def test_attempts_reset_when_stop_hook_not_active(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r1 = run_stop_gate(proj, "sess1", stop_hook_active=False, phase="checks")
            self.assertEqual(r1.returncode, 2)
            self.assertEqual(attempts_count(proj, "sess1"), "1")

            r2 = run_stop_gate(proj, "sess1", stop_hook_active=False, phase="checks")
            self.assertEqual(r2.returncode, 2)
            self.assertEqual(attempts_count(proj, "sess1"), "1")


class RulesPhaseDoesNotBlockConversationTest(unittest.TestCase):
    """rules フェーズは失敗しても exit 2 で stderr に出すだけで、
    stop-test-gate.sh に渡した時点で会話は止まらない（PostToolUse の性質）。
    ここでは gate 本体の出力形式（decision フィールドを出さない）だけを確認する。"""

    def test_failure_exits_2_with_stderr_and_no_stdout_decision(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["echo BOOM && false"]}]})
            write_changed_files(proj, "sess1", "x.py")
            r = run_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(r.returncode, 2)
            self.assertIn("BOOM", r.stderr)
            self.assertNotIn("decision", r.stdout)


# ---- checks フェーズの exit 2 は stdout に JSON を必ず出す ----
# harness 側に「stdout が空 かつ stderr が "no such file"/"can't open" に一致」すると
# Stop/SubagentStop の exit 2 を non-blocking 扱いにしてしまう既知の不具合があるため、
# consistency checks 失敗時も stdout に JSON を出してブロックを確定させる。
class ChecksPhaseFailureStdoutTest(unittest.TestCase):
    def test_checks_phase_failure_exits_2_with_parseable_json_stdout(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["echo BOOM && false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = run_stop_gate(proj, "sess1", stop_hook_active=False, phase="checks")
            self.assertEqual(r.returncode, 2)
            self.assertIn("BOOM", r.stderr)
            self.assertNotEqual(r.stdout.strip(), "")
            payload = json.loads(r.stdout)
            self.assertEqual(payload.get("decision"), "block")
            self.assertTrue(payload.get("reason"))

    def test_checks_phase_failure_json_stdout_survives_no_such_file_stderr(self):
        """バイナリ解析で判明した実際の再現条件: stderr に 'no such file' が含まれていても
        stdout に JSON があれば non-blocking 誤判定の入口（stdout が空）に該当しない。"""
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(
                proj, "sess1", ["cat /no/such/file/here 2>&1; false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = run_stop_gate(proj, "sess1", stop_hook_active=False, phase="checks")
            self.assertEqual(r.returncode, 2)
            self.assertIn("no such file", r.stderr.lower())
            self.assertNotEqual(r.stdout.strip(), "")
            json.loads(r.stdout)

    def test_checks_phase_success_has_no_decision_field(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["true"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = run_stop_gate(proj, "sess1", stop_hook_active=False, phase="checks")
            self.assertEqual(r.returncode, 0)
            if r.stdout.strip():
                payload = json.loads(r.stdout)
                self.assertNotIn("decision", payload)

    def test_max_attempts_giveup_stdout_has_no_decision_field(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1", ["false"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = None
            for i in range(5):
                r = run_stop_gate(proj, "sess1", stop_hook_active=(i > 0), phase="checks")
            self.assertEqual(r.returncode, 0)
            payload = json.loads(r.stdout)
            self.assertNotIn("decision", payload)


# ---- worktree グルーピング（サブエージェント委譲時の gate 素通り対策、rules フェーズ） ----
def _changed_lines(project_dir, state_id):
    path = os.path.join(project_dir, ".claude", ".gate-status", f"changed_files.{state_id}.txt")
    with open(path) as fh:
        return [l.strip() for l in fh if l.strip()]


class WorktreeGroupingTest(unittest.TestCase):
    def test_worktree_path_uses_worktree_gate_yaml_and_cwd(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.md", "run": ["true"]}]})
            wt = os.path.join(proj, ".claude", "worktrees", "agent-a1")
            pkg_dir = os.path.join(wt, "pkg")
            os.makedirs(pkg_dir)
            write_gate_yaml(wt, {
                "rules": [{"match": "pkg/*.go", "dir": "pkg", "run": ["touch ok.marker"]}]
            })
            abs_file = os.path.join(wt, "pkg", "foo.go")
            write_changed_files(proj, "sess1", abs_file)
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.exists(os.path.join(pkg_dir, "ok.marker")))
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

    def test_missing_worktree_gate_yaml_falls_back_to_main_cfg(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "pkg/*.go", "dir": "pkg", "run": ["touch fallback.marker"]}]
            })
            wt = os.path.join(proj, ".claude", "worktrees", "agent-a2")
            pkg_dir = os.path.join(wt, "pkg")
            os.makedirs(pkg_dir)  # wt/.claude/gate.yaml は書かない -> フォールバック
            abs_file = os.path.join(wt, "pkg", "foo.go")
            write_changed_files(proj, "sess1", abs_file)
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            # メインの cfg のルールが、cwd は proj/pkg ではなく wt/pkg で実行された
            self.assertTrue(os.path.exists(os.path.join(pkg_dir, "fallback.marker")))
            self.assertFalse(os.path.exists(os.path.join(proj, "pkg")))

    def test_main_and_worktree_mixed_memo_runs_both_roots(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "docs"))
            write_gate_yaml(proj, {
                "rules": [{"match": "docs/*.md", "dir": "docs", "run": ["touch main.marker"]}]
            })
            wt = os.path.join(proj, ".claude", "worktrees", "agent-a3")
            pkg_dir = os.path.join(wt, "pkg")
            os.makedirs(pkg_dir)
            write_gate_yaml(wt, {
                "rules": [{"match": "pkg/*.go", "dir": "pkg", "run": ["touch wt.marker"]}]
            })
            abs_file = os.path.join(wt, "pkg", "foo.go")
            write_changed_files(proj, "sess1", "docs/readme.md", abs_file)
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.exists(os.path.join(proj, "docs", "main.marker")))
            self.assertTrue(os.path.exists(os.path.join(pkg_dir, "wt.marker")))
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

    def test_failure_writes_back_raw_representation(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "docs"))
            write_gate_yaml(proj, {
                "rules": [{"match": "docs/*.md", "dir": "docs", "run": ["touch main.marker"]}]
            })
            wt = os.path.join(proj, ".claude", "worktrees", "agent-a4")
            pkg_dir = os.path.join(wt, "pkg")
            os.makedirs(pkg_dir)
            write_gate_yaml(wt, {
                "rules": [{"match": "pkg/*.go", "dir": "pkg", "run": ["false"]}]
            })
            abs_file = os.path.join(wt, "pkg", "foo.go")
            write_changed_files(proj, "sess1", "docs/readme.md", abs_file)
            mod = load_stop_gate(proj, "sess1", stop_hook_active=False, phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 2)
            # worktree 分は失敗したので元の絶対パス表記のまま CHANGED に残る
            self.assertEqual(_changed_lines(proj, "sess1"), [abs_file])
            # main 分は run_checks が無いので、成功済みとして完全に手を離している
            # （SIDECAR には退避しない）
            self.assertFalse(os.path.exists(sidecar_path(proj, "sess1")))

    def test_missing_worktree_directory_is_skipped_with_warning(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "docs"))
            write_gate_yaml(proj, {
                "rules": [{"match": "docs/*.md", "dir": "docs", "run": ["touch main.marker"]}]
            })
            # agent-ghost ディレクトリは一度も作らない
            ghost_file = os.path.join(proj, ".claude", "worktrees", "agent-ghost", "pkg", "foo.go")
            write_changed_files(proj, "sess1", "docs/readme.md", ghost_file)
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.exists(os.path.join(proj, "docs", "main.marker")))
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))

    def test_missing_worktree_directory_is_consumed_others_continue_on_failure(self):
        with tempfile.TemporaryDirectory() as proj:
            os.makedirs(os.path.join(proj, "a"))
            write_gate_yaml(proj, {
                "rules": [{"match": "a/*.txt", "dir": "a", "run": ["false"]}]
            })
            ghost_file = os.path.join(proj, ".claude", "worktrees", "agent-ghost", "pkg", "foo.go")
            write_changed_files(proj, "sess1", "a/x.txt", ghost_file)
            mod = load_stop_gate(proj, "sess1", stop_hook_active=False, phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 2)
            self.assertEqual(_changed_lines(proj, "sess1"), ["a/x.txt"])
            self.assertFalse(os.path.exists(sidecar_path(proj, "sess1")))


class AgentIdStateFileTest(unittest.TestCase):
    def test_rules_phase_agent_id_uses_suffixed_changed_and_pending_files(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {
                "rules": [{"match": "**/*.py", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [{"name": "chk", "run": ["true"]}],
            })
            write_changed_files(proj, "sess1--agent1", "x.py")
            mod = load_stop_gate(proj, "sess1", agent_id="agent1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.exists(pending_path(proj, "sess1--agent1")))
            self.assertFalse(os.path.exists(pending_path(proj, "sess1")))

    def test_checks_phase_agent_id_uses_suffixed_attempts_file(self):
        with tempfile.TemporaryDirectory() as proj:
            _setup_reserved_check_project(proj, "sess1--agent1", ["false"])
            rules_mod = load_stop_gate(proj, "sess1", agent_id="agent1", phase="rules")
            self.assertEqual(rules_mod.main(), 0)

            r = run_stop_gate(proj, "sess1", stop_hook_active=False, agent_id="agent1", phase="checks")
            self.assertEqual(r.returncode, 2)
            self.assertTrue(os.path.exists(
                os.path.join(proj, ".claude", ".gate-status", "gate_attempts.sess1--agent1.txt")))
            self.assertFalse(os.path.exists(
                os.path.join(proj, ".claude", ".gate-status", "gate_attempts.sess1.txt")))

    def test_main_session_rules_phase_ignores_other_agent_memo(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.py", "run": ["true"]}]})
            write_changed_files(proj, "sess1--agent1", "other_agent_file.py")
            mod = load_stop_gate(proj, "sess1", phase="rules")
            rc = mod.main()
            self.assertEqual(rc, 0)
            # 実行中の別エージェントのメモには手を付けない
            self.assertTrue(os.path.exists(changed_path(proj, "sess1--agent1")))


# ---- dogwood ポリシー評価 ----
# テストは実 dogwood バイナリに依存させない。DOGWOOD_BIN に下記の偽バイナリを差し、
# verdict / 異常終了 / 壊れた出力を制御する。
FAKE_DOGWOOD_SRC = '''#!@PY@
import json, sys, os

conf = json.load(open("@CONF@"))
argv = sys.argv[1:]
trace = ""
if "--trace" in argv:
    trace = open(argv[argv.index("--trace") + 1]).read()

prior_calls = []
if os.path.exists(conf["calls"]):
    with open(conf["calls"]) as fh:
        prior_calls = [json.loads(l) for l in fh if l.strip()]

with open(conf["calls"], "a") as fh:
    fh.write(json.dumps({"argv": argv, "trace": trace}) + "\\n")

mode = conf["mode"]
if mode == "fail":
    sys.stderr.write("boom\\n")
    sys.exit(1)
if mode == "broken":
    sys.stdout.write("<<not json>>")
    sys.exit(0)
if mode == "empty":
    sys.stdout.write(json.dumps({"verdicts": []}))
    sys.exit(0)

def last_line(t):
    return (t.strip().splitlines() or [""])[-1]

last = last_line(trace)
flip = conf.get("deny_after_first_call") or []
if any(s in last for s in flip):
    seen_before = any(any(s in last_line(c["trace"]) for s in flip) for c in prior_calls)
    verdict = "deny" if seen_before else conf["verdict"]
elif any(s in last for s in conf["deny"]):
    verdict = "deny"
else:
    verdict = conf["verdict"]
sys.stdout.write(json.dumps({"verdicts": [{"index": 0, "verdict": verdict}]}))
'''


def write_fake_dogwood(dirpath, verdict="allow", mode="ok", deny=(), deny_after_first_call=()):
    """偽 dogwood を作り (バイナリパス, 呼び出し記録 jsonl のパス) を返す。
    mode: ok / fail(非0終了) / broken(JSON にならない出力) / empty(verdicts が空)。
    deny に渡した文字列がトレース最終行（＝今回の request）に含まれれば deny を返す。
    deny_after_first_call に渡した文字列がトレース最終行に含まれる場合、その文字列での
    最初の呼び出しだけ既定の verdict を返し、2回目以降は deny を返す（同一
    (root, cwd, cmd) が同じ回の中で allow の後に deny される経路を再現するため）。"""
    os.makedirs(dirpath, exist_ok=True)
    calls = os.path.join(dirpath, "calls.jsonl")
    conf = os.path.join(dirpath, "conf.json")
    with open(conf, "w") as fh:
        json.dump({"verdict": verdict, "mode": mode, "deny": list(deny),
                   "deny_after_first_call": list(deny_after_first_call), "calls": calls}, fh)
    path = os.path.join(dirpath, "dogwood")
    with open(path, "w") as fh:
        fh.write(FAKE_DOGWOOD_SRC.replace("@PY@", sys.executable).replace("@CONF@", conf))
    os.chmod(path, 0o755)
    return path, calls


def read_calls(calls_path):
    if not os.path.exists(calls_path):
        return []
    with open(calls_path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def write_policy(project_dir, rel=".claude/policies/gate.dw"):
    path = os.path.join(project_dir, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("permit (principal, action == Gate::Action::\"Run\", resource);\n")
    return path


def trace_path(project_dir, state_id):
    return os.path.join(project_dir, ".claude", ".gate-status", f"gate_trace.{state_id}.jsonl")


def read_trace_records(project_dir, state_id):
    path = trace_path(project_dir, state_id)
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def write_trace_records(project_dir, state_id, records):
    path = trace_path(project_dir, state_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def deferred_path(project_dir, state_id):
    return os.path.join(project_dir, ".claude", ".gate-status", f"gate_deferred.{state_id}.json")


def read_deferred(project_dir, state_id):
    path = deferred_path(project_dir, state_id)
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return json.load(fh)


def write_deferred(project_dir, state_id, entries):
    path = deferred_path(project_dir, state_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(entries, fh)


class ResolveDogwoodTest(unittest.TestCase):
    def test_dogwood_bin_env_is_used_as_is(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _ = write_fake_dogwood(os.path.join(proj, "bin"))
            mod = load_stop_gate(proj, "sess1", dogwood_bin=fake)
            self.assertEqual(mod.resolve_dogwood(), fake)

    def test_missing_dogwood_bin_env_does_not_fall_back_to_path(self):
        # 明示指定が存在しないときに PATH 上の実バイナリへ落ちると、テストが
        # 実 dogwood に依存してしまう。明示指定は最後まで尊重する。
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1", dogwood_bin=os.path.join(proj, "nope"))
            self.assertIsNone(mod.resolve_dogwood())


class CedarTraceLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_quotes_and_backslashes_are_escaped(self):
        self.assertEqual(self.mod.cedar_string('a"b\\c'), '"a\\"b\\\\c"')

    def test_request_line_carries_ts_project_name_and_cmd(self):
        rec = {"ts": 1000, "name": "hooks-pytest", "cmd": "pytest tests -q", "kind": "request"}
        line = self.mod.trace_line(rec, "claude", 0)
        self.assertTrue(line.startswith("@1000 "))
        self.assertIn('Gate::Agent::"gate"', line)
        self.assertIn('Gate::Project::"claude"', line)
        self.assertIn('Gate::Action::"Run"::request(', line)
        self.assertIn('name: "hooks-pytest"', line)
        self.assertIn('cmd: "pytest tests -q"', line)

    def test_history_kinds_use_their_own_event_name(self):
        for kind in ("response", "error"):
            with self.subTest(kind=kind):
                line = self.mod.trace_line({"ts": 1, "name": "n", "cmd": "c", "kind": kind}, "p", 1)
                self.assertIn(f'Gate::Action::"Run"::{kind}(', line)


class PolicyPathResolutionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = load_stop_gate(self.tmp)

    def test_relative_path_is_resolved_from_root_dir(self):
        self.assertEqual(
            self.mod.resolve_policy_path("/root", ".claude/policies/gate.dw"),
            "/root/.claude/policies/gate.dw",
        )

    def test_absolute_and_tilde_paths_are_kept(self):
        self.assertEqual(self.mod.resolve_policy_path("/root", "/abs/gate.dw"), "/abs/gate.dw")
        self.assertEqual(
            self.mod.resolve_policy_path("/root", "~/gate.dw"),
            os.path.join(os.path.expanduser("~"), "gate.dw"),
        )

    def test_rule_policy_overrides_top_level(self):
        top = write_policy(self.tmp, ".claude/policies/gate.dw")
        rule = write_policy(self.tmp, ".claude/policies/hooks.dw")
        cfg = {"policy": ".claude/policies/gate.dw"}
        owner = {"policy": ".claude/policies/hooks.dw"}
        self.assertEqual(self.mod.policy_paths(cfg, owner, self.tmp)[0], rule)
        self.assertEqual(self.mod.policy_paths(cfg, {}, self.tmp)[0], top)

    def test_default_schema_is_used_when_not_configured(self):
        write_policy(self.tmp)
        _, schema, _ = self.mod.policy_paths({"policy": ".claude/policies/gate.dw"}, {}, self.tmp)
        self.assertEqual(schema, self.mod.DEFAULT_POLICY_SCHEMA)
        self.assertTrue(os.path.exists(schema))

    def test_unset_policy_falls_back_to_the_bundled_default(self):
        policy, schema, is_default = self.mod.policy_paths({}, {}, self.tmp)
        self.assertEqual(policy, self.mod.DEFAULT_POLICY)
        self.assertEqual(schema, self.mod.DEFAULT_POLICY_SCHEMA)
        self.assertTrue(is_default)
        self.assertTrue(os.path.exists(policy))

    def test_explicit_policy_is_not_flagged_as_default(self):
        write_policy(self.tmp)
        self.assertFalse(self.mod.policy_paths({"policy": ".claude/policies/gate.dw"}, {}, self.tmp)[2])

    def test_missing_default_policy_file_disables_the_mechanism(self):
        self.mod.DEFAULT_POLICY = os.path.join(self.tmp, "ghost-default.dw")
        self.assertIsNone(self.mod.policy_paths({}, {}, self.tmp))

    def test_missing_policy_file_disables_the_mechanism_and_logs(self):
        logs = []
        self.assertIsNone(self.mod.policy_paths({"policy": "ghost.dw"}, {}, self.tmp, logs))
        self.assertTrue(any("ghost.dw" in line for line in logs))

    def test_false_disables_the_mechanism(self):
        self.assertIsNone(self.mod.policy_paths({"policy": False}, {}, self.tmp))

    def test_rule_false_overrides_a_top_level_path(self):
        write_policy(self.tmp)
        cfg = {"policy": ".claude/policies/gate.dw"}
        self.assertIsNone(self.mod.policy_paths(cfg, {"policy": False}, self.tmp))

    def test_rule_without_policy_inherits_top_level_false_instead_of_the_default(self):
        self.assertIsNone(self.mod.policy_paths({"policy": False}, {"match": "x"}, self.tmp))

    def test_rule_path_overrides_a_top_level_false(self):
        rule = write_policy(self.tmp, ".claude/policies/hooks.dw")
        cfg = {"policy": False}
        owner = {"policy": ".claude/policies/hooks.dw"}
        self.assertEqual(self.mod.policy_paths(cfg, owner, self.tmp)[0], rule)


class TraceStoreTest(unittest.TestCase):
    def test_records_are_scoped_to_their_root(self):
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1")
            mod.append_trace(proj, proj, "a", "cmd-a", "request")
            mod.append_trace("/other/root", "/other/root", "b", "cmd-b", "request")
            self.assertEqual([r["cmd"] for r in mod.read_trace(proj)], ["cmd-a"])
            self.assertEqual([r["cmd"] for r in mod.read_trace("/other/root")], ["cmd-b"])

    def test_timestamp_is_monotonic_non_decreasing_per_root(self):
        with tempfile.TemporaryDirectory() as proj:
            future = int(time.time()) + 5000
            write_trace_records(proj, "sess1", [
                {"ts": future, "root": proj, "cwd": proj, "name": "a", "cmd": "a", "kind": "request"},
            ])
            mod = load_stop_gate(proj, "sess1")
            ts = mod.append_trace(proj, proj, "b", "b", "response")
            self.assertGreaterEqual(ts, future)

    def test_records_older_than_the_window_are_pruned_on_write(self):
        with tempfile.TemporaryDirectory() as proj:
            now = int(time.time())
            write_trace_records(proj, "sess1", [
                {"ts": now - 90000, "root": proj, "cwd": proj, "name": "old", "cmd": "old", "kind": "error"},
                {"ts": now - 60, "root": proj, "cwd": proj, "name": "recent", "cmd": "recent", "kind": "error"},
            ])
            mod = load_stop_gate(proj, "sess1")
            mod.append_trace(proj, proj, "new", "new", "request")
            names = [r["name"] for r in read_trace_records(proj, "sess1")]
            self.assertEqual(names, ["recent", "new"])

    def test_broken_lines_are_ignored(self):
        with tempfile.TemporaryDirectory() as proj:
            path = trace_path(proj, "sess1")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write("<<broken>>\n")
            mod = load_stop_gate(proj, "sess1")
            mod.append_trace(proj, proj, "a", "a", "request")
            self.assertEqual([r["name"] for r in mod.read_trace(proj)], ["a"])


class DeferredStoreTest(unittest.TestCase):
    def test_entries_are_deduped_by_root_cwd_and_cmd(self):
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1")
            mod.defer_cmd(proj, proj, "n", "pytest -q", 300, "hooks")
            mod.defer_cmd(proj, proj, "n2", "pytest -q", 60, "hooks")
            mod.defer_cmd(proj, os.path.join(proj, "sub"), "n", "pytest -q", 300, "sub")
            entries = read_deferred(proj, "sess1")
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[0]["timeout"], 300)

    def test_take_deferred_returns_all_and_empties_the_store(self):
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1")
            mod.defer_cmd(proj, proj, "n", "a", 300, "x")
            self.assertEqual(len(mod.take_deferred()), 1)
            self.assertEqual(read_deferred(proj, "sess1"), [])


class ChecksPhaseDrainsDeferredTest(unittest.TestCase):
    """checks フェーズ（Stop / SubagentStop / commit・push 前の同期検証）は控えを消化する。
    rules フェーズで実行が無いと控えが残り続け、未検証のまま commit されるため。"""

    def _entry(self, proj, cmd):
        return {"root": proj, "cwd": proj, "name": "n%d" % abs(hash(cmd)), "cmd": cmd, "timeout": 30,
                "label": "x", "env": {}}

    def test_runs_deferred_without_pending_checks_and_empties_the_store(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.go", "run": ["true"]}]})
            marker = os.path.join(proj, "ran.txt")
            write_deferred(proj, "sess1", [self._entry(proj, "echo ok > %s" % marker)])
            r = run_stop_gate(proj, phase="checks")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_blocks_and_keeps_only_failed_deferred(self):
        with tempfile.TemporaryDirectory() as proj:
            write_gate_yaml(proj, {"rules": [{"match": "**/*.go", "run": ["true"]}]})
            write_deferred(proj, "sess1", [self._entry(proj, "true"),
                                           self._entry(proj, "echo deferred-failed; exit 1")])
            r = run_stop_gate(proj, phase="checks")
            self.assertEqual(r.returncode, 2)
            self.assertIn("deferred-failed", r.stderr)
            self.assertEqual([e["cmd"] for e in read_deferred(proj, "sess1")],
                             ["echo deferred-failed; exit 1"])


class PolicyDisabledTest(unittest.TestCase):
    def _run_rules(self, proj, gate, dogwood_bin):
        marker = os.path.join(proj, "ran.marker")
        gate["rules"] = [{"match": "**/*.py", "run": [f"touch {marker}"]}]
        write_gate_yaml(proj, gate)
        write_changed_files(proj, "sess1", "x.py")
        mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=dogwood_bin)
        self.assertEqual(mod.main(), 0)
        return marker

    def test_policy_false_runs_commands_without_asking_dogwood(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), verdict="deny")
            marker = self._run_rules(proj, {"policy": False}, fake)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_calls(calls), [])
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_rule_policy_false_overrides_a_top_level_path(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), verdict="deny")
            write_policy(proj)
            marker = os.path.join(proj, "ran.marker")
            write_gate_yaml(proj, {
                "policy": ".claude/policies/gate.dw",
                "rules": [{"match": "**/*.py", "policy": False, "run": [f"touch {marker}"]}],
            })
            write_changed_files(proj, "sess1", "x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_calls(calls), [])

    def test_rule_policy_path_overrides_a_top_level_false(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), verdict="deny")
            rule_policy = write_policy(proj, ".claude/policies/hooks.dw")
            marker = os.path.join(proj, "ran.marker")
            write_gate_yaml(proj, {
                "policy": False,
                "rules": [{
                    "match": "**/*.py",
                    "policy": ".claude/policies/hooks.dw",
                    "run": [{"cmd": f"touch {marker}", "name": "pkg-a"}],
                }],
            })
            write_changed_files(proj, "sess1", "x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(marker))
            self.assertEqual(read_calls(calls)[0]["argv"][1], rule_policy)

    def test_missing_policy_file_runs_commands_as_before(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), verdict="deny")
            marker = self._run_rules(proj, {"policy": ".claude/policies/ghost.dw"}, fake)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_calls(calls), [])
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_missing_policy_file_is_logged_by_run_rules(self):
        # 設定ミスを黙って既定ポリシーで埋めない（気づけるようログに残す）。
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1", phase="rules")
            cfg = {
                "policy": ".claude/policies/ghost.dw",
                "rules": [{"match": "**/*.py", "run": ["true"]}],
            }
            logs = []
            mod.run_rules(cfg, ["x.py"], logs, proj, mod.PolicyState())
            self.assertTrue(any("ghost.dw" in line for line in logs))

    def test_missing_policy_file_is_logged_by_run_named_checks(self):
        with tempfile.TemporaryDirectory() as proj:
            mod = load_stop_gate(proj, "sess1", phase="checks")
            cfg = {"policy": ".claude/policies/ghost.dw"}
            logs = []
            mod.run_named_checks({"chk": {"name": "chk", "run": ["true"]}}, ["chk"],
                                 logs, proj, cfg, mod.PolicyState())
            self.assertTrue(any("ghost.dw" in line for line in logs))


class DefaultPolicyTest(unittest.TestCase):
    """policy: を書かなくても同梱の既定ポリシーで判定される。ただし既定適用中に
    dogwood が入っていない環境では、全コマンドを止めないよう素通しする。"""

    def _project(self, proj, name="pkg-a", fake_kwargs=None):
        fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), **(fake_kwargs or {}))
        marker = os.path.join(proj, "ran.marker")
        write_gate_yaml(proj, {
            "rules": [{"match": "**/*.py", "run": [{"cmd": f"touch {marker}", "name": name}]}],
        })
        write_changed_files(proj, "sess1", "x.py")
        return fake, calls, marker

    def test_bundled_default_policy_is_used_when_policy_is_unset(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls, marker = self._project(proj)
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_calls(calls)[0]["argv"][1], mod.DEFAULT_POLICY)

    def test_default_policy_deny_skips_and_defers(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _, marker = self._project(proj, fake_kwargs={"deny": ["pkg-a"]})
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(marker))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

    def test_missing_dogwood_runs_the_command_without_deferring(self):
        with tempfile.TemporaryDirectory() as proj:
            _, _, marker = self._project(proj)
            mod = load_stop_gate(proj, "sess1", phase="rules",
                                 dogwood_bin=os.path.join(proj, "nope"))
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_deferred(proj, "sess1"), [])
            # 判定していないので request は残らない。実行結果だけは履歴に積み、
            # 後から dogwood を入れたときに間引きの材料になるようにする。
            self.assertEqual([r["kind"] for r in read_trace_records(proj, "sess1")], ["response"])

    def test_broken_dogwood_still_skips_and_defers(self):
        # fail-open するのはバイナリ不在のときだけ。dogwood は在るのに評価できない
        # ケースは、明示指定と同じくスキップして控えに積む。
        for mode in ("fail", "broken", "empty"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as proj:
                fake, _, marker = self._project(proj, fake_kwargs={"mode": mode})
                mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
                self.assertEqual(mod.main(), 0)
                self.assertFalse(os.path.exists(marker))
                self.assertEqual(len(read_deferred(proj, "sess1")), 1)

    def test_missing_default_policy_file_runs_the_command(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls, marker = self._project(proj, fake_kwargs={"verdict": "deny"})
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            mod.DEFAULT_POLICY = os.path.join(proj, "ghost-default.dw")
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(read_calls(calls), [])

    def test_default_policy_applies_to_consistency_checks(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _ = write_fake_dogwood(os.path.join(proj, "bin"), deny=["chk-cmd"])
            marker = os.path.join(proj, "chk.marker")
            write_gate_yaml(proj, {
                "rules": [{"match": "**/*.py", "run": ["true"], "run_checks": ["chk"]}],
                "consistency_checks": [
                    {"name": "chk", "run": [{"cmd": f"touch {marker}", "name": "chk-cmd"}]},
                ],
            })
            write_changed_files(proj, "sess1", "x.py")
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake).main(), 0)
            self.assertEqual(load_stop_gate(proj, "sess1", phase="checks", dogwood_bin=fake).main(), 0)
            self.assertFalse(os.path.exists(marker))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)


def _policy_project(proj, run, fake_kwargs=None, rule_extra=None):
    """policy を設定した gate.yaml と偽 dogwood を用意し、(バイナリ, 呼び出し記録) を返す。"""
    fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), **(fake_kwargs or {}))
    write_policy(proj)
    rule = {"match": "**/*.py", "run": run}
    rule.update(rule_extra or {})
    write_gate_yaml(proj, {"policy": ".claude/policies/gate.dw", "rules": [rule]})
    write_changed_files(proj, "sess1", "x.py")
    return fake, calls


class PolicyDecisionTest(unittest.TestCase):
    def test_allow_runs_the_command_and_records_request_and_response(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, calls = _policy_project(proj, [{"cmd": f"touch {marker}", "name": "pkg-a"}])
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertEqual(len(read_calls(calls)), 1)
            kinds = [(r["kind"], r["name"]) for r in read_trace_records(proj, "sess1")]
            self.assertEqual(kinds, [("request", "pkg-a"), ("response", "pkg-a")])

    def test_allow_with_failing_command_records_error(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _ = _policy_project(proj, [{"cmd": "false", "name": "pkg-a"}])
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 2)
            kinds = [r["kind"] for r in read_trace_records(proj, "sess1")]
            self.assertEqual(kinds, ["request", "error"])

    def test_deny_skips_the_command_without_failing_the_phase(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(
                proj, [{"cmd": f"touch {marker}", "name": "pkg-a"}],
                fake_kwargs={"deny": ["pkg-a"]},
            )
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(marker))
            # スキップは失敗ではないので、成功時と同じくファイルは CHANGED から外れる
            self.assertFalse(os.path.exists(changed_path(proj, "sess1")))
            self.assertEqual([r["kind"] for r in read_trace_records(proj, "sess1")], ["request"])
            entries = read_deferred(proj, "sess1")
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["cmd"], f"touch {marker}")
            self.assertEqual(entries[0]["name"], "pkg-a")

    def test_name_defaults_to_slug_of_the_command(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _ = _policy_project(proj, ["true"])
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertEqual(
                [r["name"] for r in read_trace_records(proj, "sess1")],
                [mod.slug("true"), mod.slug("true")],
            )


class PolicyEvaluationFailureTest(unittest.TestCase):
    """ポリシーはあるのに評価できない場合は、実行せず控えへ積む（失敗にはしない）。"""

    def _assert_skipped_and_deferred(self, proj, fake):
        marker = os.path.join(proj, "ran.marker")
        mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
        self.assertEqual(mod.main(), 0)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(len(read_deferred(proj, "sess1")), 1)
        self.assertEqual(read_trace_records(proj, "sess1"), [])

    def test_dogwood_binary_missing(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            _policy_project(proj, [f"touch {marker}"])
            self._assert_skipped_and_deferred(proj, os.path.join(proj, "nope"))

    def test_dogwood_exits_non_zero(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(proj, [f"touch {marker}"], fake_kwargs={"mode": "fail"})
            self._assert_skipped_and_deferred(proj, fake)

    def test_dogwood_prints_broken_json(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(proj, [f"touch {marker}"], fake_kwargs={"mode": "broken"})
            self._assert_skipped_and_deferred(proj, fake)

    def test_dogwood_returns_no_verdicts(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(proj, [f"touch {marker}"], fake_kwargs={"mode": "empty"})
            self._assert_skipped_and_deferred(proj, fake)


class RulePolicyOverrideTest(unittest.TestCase):
    def test_rule_policy_is_passed_to_dogwood_instead_of_top_level(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls = write_fake_dogwood(os.path.join(proj, "bin"))
            write_policy(proj, ".claude/policies/gate.dw")
            rule_policy = write_policy(proj, ".claude/policies/hooks.dw")
            write_gate_yaml(proj, {
                "policy": ".claude/policies/gate.dw",
                "rules": [{
                    "match": "**/*.py",
                    "policy": ".claude/policies/hooks.dw",
                    "run": ["true"],
                }],
            })
            write_changed_files(proj, "sess1", "x.py")
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            argv = read_calls(calls)[0]["argv"]
            self.assertEqual(argv[0], "replay")
            self.assertEqual(argv[1], rule_policy)


class DeferredDrainTest(unittest.TestCase):
    def _two_rule_project(self, proj):
        fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), deny=["pkg-a"])
        write_policy(proj)
        marker_a = os.path.join(proj, "a.marker")
        marker_b = os.path.join(proj, "b.marker")
        write_gate_yaml(proj, {
            "policy": ".claude/policies/gate.dw",
            "rules": [
                {"match": "a.py", "run": [{"cmd": f"touch {marker_a}", "name": "pkg-a"}]},
                {"match": "b.py", "run": [{"cmd": f"touch {marker_b}", "name": "pkg-b"}]},
            ],
        })
        return fake, calls, marker_a, marker_b

    def test_deferred_is_drained_on_the_run_where_a_command_was_allowed(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, calls, marker_a, marker_b = self._two_rule_project(proj)

            write_changed_files(proj, "sess1", "a.py")
            first = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(first.main(), 0)
            self.assertFalse(os.path.exists(marker_a))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

            write_changed_files(proj, "sess1", "b.py")
            second = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(second.main(), 0)
            self.assertTrue(os.path.exists(marker_b))
            self.assertTrue(os.path.exists(marker_a))
            self.assertEqual(read_deferred(proj, "sess1"), [])
            # 控えの消化はポリシー判定をバイパスする（deny のままでは永久に消化されない）
            self.assertEqual(len(read_calls(calls)), 2)

    def test_drained_command_result_is_recorded_without_a_request(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _, _, _ = self._two_rule_project(proj)
            write_changed_files(proj, "sess1", "a.py")
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake).main(), 0)
            write_changed_files(proj, "sess1", "b.py")
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake).main(), 0)
            kinds = [(r["kind"], r["name"]) for r in read_trace_records(proj, "sess1")]
            self.assertEqual(kinds, [
                ("request", "pkg-a"),
                ("request", "pkg-b"), ("response", "pkg-b"),
                ("response", "pkg-a"),
            ])

    def test_command_deferred_in_the_same_run_as_an_allow_is_not_drained_that_run(self):
        # pkg-a が deny されて控えに積まれるのと同じ回に pkg-b が allow されても、
        # pkg-a はその場では積まれたばかりで消化対象にならない。
        with tempfile.TemporaryDirectory() as proj:
            fake, _, marker_a, marker_b = self._two_rule_project(proj)

            write_changed_files(proj, "sess1", "a.py", "b.py")
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(marker_a))
            self.assertTrue(os.path.exists(marker_b))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

    def test_entry_deferred_in_a_prior_run_is_drained_on_a_later_allowed_run(self):
        # 前回積まれた pkg-a は、次の回で別のコマンドが allow されたときに消化される。
        with tempfile.TemporaryDirectory() as proj:
            fake, _, marker_a, marker_b = self._two_rule_project(proj)

            write_changed_files(proj, "sess1", "a.py", "b.py")
            first = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(first.main(), 0)
            self.assertFalse(os.path.exists(marker_a))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

            write_changed_files(proj, "sess1", "b.py")
            second = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(second.main(), 0)
            self.assertTrue(os.path.exists(marker_a))
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_key_re_deferred_after_being_allowed_in_the_same_run_is_not_drained_that_run(self):
        # pkg-a と同じ (root, cwd, cmd) を参照する2つのルールが同じ回で順に評価され、
        # 1つ目は allow されて実行、2つ目は deny されて控えに積み直される場合、前回から
        # 控えにあったキーと一致していても、その回の消化では拾わない。
        with tempfile.TemporaryDirectory() as proj:
            counter = os.path.join(proj, "count.txt")
            write_policy(proj)
            write_gate_yaml(proj, {
                "policy": ".claude/policies/gate.dw",
                "rules": [
                    {"match": "a.py", "run": [{"cmd": f"echo x >> {counter}", "name": "pkg-a"}]},
                    {"match": "b.py", "run": [{"cmd": f"echo x >> {counter}", "name": "pkg-a"}]},
                ],
            })
            seed_bin, _ = write_fake_dogwood(os.path.join(proj, "seed-bin"), deny=["pkg-a"])
            flip_bin, _ = write_fake_dogwood(os.path.join(proj, "flip-bin"),
                                             deny_after_first_call=["pkg-a"])

            write_changed_files(proj, "sess1", "a.py")
            seed = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=seed_bin)
            self.assertEqual(seed.main(), 0)
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

            write_changed_files(proj, "sess1", "a.py", "b.py")
            flip = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=flip_bin)
            self.assertEqual(flip.main(), 0)
            with open(counter) as fh:
                self.assertEqual(len(fh.read().splitlines()), 1)
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

    def test_deferred_entry_with_vanished_cwd_is_discarded_without_running(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _, _, marker_b = self._two_rule_project(proj)
            ghost_marker = os.path.join(proj, "ghost.marker")
            write_deferred(proj, "sess1", [{
                "root": proj, "cwd": os.path.join(proj, "ghost"), "name": "ghost",
                "cmd": f"touch {ghost_marker}", "timeout": 300, "label": "ghost",
            }])
            write_changed_files(proj, "sess1", "b.py")
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(marker_b))
            self.assertFalse(os.path.exists(ghost_marker))
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_allow_consumes_the_same_command_left_in_the_deferred_store(self):
        # 前回 deny されて控えに残っているコマンドが今回 allow されたら、その場で
        # 実行される分だけでよい（控えの分と合わせて二重に実行しない）。
        with tempfile.TemporaryDirectory() as proj:
            counter = os.path.join(proj, "count.txt")
            write_policy(proj)
            write_gate_yaml(proj, {
                "policy": ".claude/policies/gate.dw",
                "rules": [{"match": "a.py", "run": [{"cmd": f"echo x >> {counter}", "name": "pkg-a"}]}],
            })
            deny_bin, _ = write_fake_dogwood(os.path.join(proj, "deny-bin"), deny=["pkg-a"])
            allow_bin, _ = write_fake_dogwood(os.path.join(proj, "allow-bin"))

            write_changed_files(proj, "sess1", "a.py")
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=deny_bin).main(), 0)
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

            write_changed_files(proj, "sess1", "a.py")
            self.assertEqual(load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=allow_bin).main(), 0)
            with open(counter) as fh:
                self.assertEqual(len(fh.read().splitlines()), 1)
            self.assertEqual(read_deferred(proj, "sess1"), [])

    def test_deferred_is_not_drained_when_nothing_was_allowed(self):
        with tempfile.TemporaryDirectory() as proj:
            fake, _, marker_a, _ = self._two_rule_project(proj)
            write_changed_files(proj, "sess1", "a.py")
            for _ in range(2):
                mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
                self.assertEqual(mod.main(), 0)
            self.assertFalse(os.path.exists(marker_a))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)


class ChecksPhasePolicyTest(unittest.TestCase):
    def _reserved_check_project(self, proj, check_run, fake_kwargs=None, check_extra=None):
        fake, calls = write_fake_dogwood(os.path.join(proj, "bin"), **(fake_kwargs or {}))
        write_policy(proj)
        check = {"name": "chk", "run": check_run}
        check.update(check_extra or {})
        write_gate_yaml(proj, {
            "policy": ".claude/policies/gate.dw",
            "rules": [{"match": "**/*.py", "run": ["true"], "run_checks": ["chk"]}],
            "consistency_checks": [check],
        })
        write_changed_files(proj, "sess1", "x.py")
        return fake, calls

    def test_consistency_check_command_is_denied_and_skipped(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "chk.marker")
            fake, _ = self._reserved_check_project(
                proj, [{"cmd": f"touch {marker}", "name": "chk-cmd"}],
                fake_kwargs={"deny": ["chk-cmd"]},
            )
            rules_mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(rules_mod.main(), 0)
            checks_mod = load_stop_gate(proj, "sess1", phase="checks", dogwood_bin=fake)
            self.assertEqual(checks_mod.main(), 0)
            self.assertFalse(os.path.exists(marker))
            self.assertEqual(len(read_deferred(proj, "sess1")), 1)

    def test_checks_phase_drains_the_deferred_store_along_with_reserved_checks(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "chk.marker")
            deferred_marker = os.path.join(proj, "deferred.marker")
            fake, _ = self._reserved_check_project(proj, [f"touch {marker}"])
            rules_mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(rules_mod.main(), 0)
            write_deferred(proj, "sess1", [{
                "root": proj, "cwd": proj, "name": "left-over",
                "cmd": f"touch {deferred_marker}", "timeout": 300, "label": ".",
            }])
            checks_mod = load_stop_gate(proj, "sess1", phase="checks", dogwood_bin=fake)
            self.assertEqual(checks_mod.main(), 0)
            self.assertTrue(os.path.exists(marker))
            self.assertTrue(os.path.exists(deferred_marker))
            self.assertEqual(read_deferred(proj, "sess1"), [])


class PolicyStateFileNamingTest(unittest.TestCase):
    def test_state_files_are_split_by_state_id(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(proj, [{"cmd": f"touch {marker}", "name": "pkg-a"}],
                                      fake_kwargs={"deny": ["pkg-a"]})
            mod = load_stop_gate(proj, "sess1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(trace_path(proj, "sess1")))
            self.assertTrue(os.path.exists(deferred_path(proj, "sess1")))

    def test_state_files_carry_the_agent_suffix(self):
        with tempfile.TemporaryDirectory() as proj:
            marker = os.path.join(proj, "ran.marker")
            fake, _ = _policy_project(proj, [{"cmd": f"touch {marker}", "name": "pkg-a"}],
                                      fake_kwargs={"deny": ["pkg-a"]})
            write_changed_files(proj, "sess1--agent1", "x.py")
            mod = load_stop_gate(proj, "sess1", agent_id="agent1", phase="rules", dogwood_bin=fake)
            self.assertEqual(mod.main(), 0)
            self.assertTrue(os.path.exists(trace_path(proj, "sess1--agent1")))
            self.assertTrue(os.path.exists(deferred_path(proj, "sess1--agent1")))
            self.assertFalse(os.path.exists(trace_path(proj, "sess1")))
            self.assertFalse(os.path.exists(deferred_path(proj, "sess1")))


def make_policy_state_files(project_dir, state_id):
    write_trace_records(project_dir, state_id, [
        {"ts": 1, "root": project_dir, "cwd": project_dir, "name": "n", "cmd": "c", "kind": "request"},
    ])
    write_deferred(project_dir, state_id, [
        {"root": project_dir, "cwd": project_dir, "name": "n", "cmd": "c", "timeout": 300, "label": "."},
    ])
    return trace_path(project_dir, state_id), deferred_path(project_dir, state_id)


class ResetGatePolicyStateTest(unittest.TestCase):
    """実行履歴（gate_trace）と控え（gate_deferred）も reset-gate.sh の掃除対象。"""

    def test_deletes_policy_state_on_startup(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_policy_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="startup")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_deletes_agent_suffixed_policy_state_on_clear(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_policy_state_files(proj, "sess1--agent1")
            r = run_reset_gate(proj, session_id="sess1", source="clear")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))

    def test_keeps_policy_state_on_resume(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_policy_state_files(proj, "sess1")
            r = run_reset_gate(proj, session_id="sess1", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertTrue(os.path.exists(f))

    def test_prunes_stale_policy_state_regardless_of_source(self):
        with tempfile.TemporaryDirectory() as proj:
            files = make_policy_state_files(proj, "sess-stale")
            for f in files:
                os.utime(f, (1000, 1000))
            r = run_reset_gate(proj, session_id="sess-current", source="resume")
            self.assertEqual(r.returncode, 0)
            for f in files:
                self.assertFalse(os.path.exists(f))


if __name__ == "__main__":
    unittest.main()
