#!/usr/bin/env python3
"""feedback ルール共通モジュール。

~/.claude/feedback/*.md の frontmatter を全件読み、count に応じた強制力
（severity: deny / ask（pre_*）・block（stop_check） / warn）を解決する。
PreToolUse hook (feedback-guard.py) / Stop hook (feedback-stop-check.py) /
UserPromptSubmit hook (feedback-inject.py) から import して使う共通ロジックのみを持つ。
"""

# enforce スキーマ（frontmatter に追記する形式。詳細は feedback/rules.md も参照）
#
# enforce:
#   - event: pre_bash          # PreToolUse(Bash) でコマンド文字列を検査
#     when: '正規表現'          # 必須。command にマッチしたら候補
#     unless: '正規表現'        # 任意。マッチすれば違反ではない
#     check: 'shell cmd'       # 任意。非0終了で違反確定（when と AND）
#     message: '違反時の指示文'
#     severity: deny           # 任意。省略時は count から自動決定
#
#   - event: pre_edit          # PreToolUse(Edit|Write|MultiEdit) で対象と内容を検査
#     path: 'glob'             # 必須。file_path にマッチ
#     exclude_path: 'glob'     # 任意。文字列または配列。path にマッチしても
#                              # これにマッチしたら検査対象外（テスト不要なファイルの除外）
#     when: '正規表現'          # 任意。new_string / content / new_source に対して
#     unless: '正規表現'        # 任意
#     absent_sibling: 'name'   # 任意。同ディレクトリにこの名前のファイルが無ければ違反
#                              # ({stem} はファイル名 (拡張子抜き) に置換される。
#                              # kebab-case/snake_case 両方の候補が展開される)
#                              # 対象ファイル自身がテストファイルの命名規則に一致する
#                              # 場合は自動的に対象外にする（tdd の自己参照を防ぐ）
#     absent_glob: 'glob'      # 任意。文字列または配列。project_dir 起点の glob で、
#                              # どれか1つでも存在すれば違反にしない（spec/ や tests/ など
#                              # 実装と別ツリーに置くテストを拾うため）。{stem} に加えて
#                              # {dir}（project_dir 相対ディレクトリ）も展開される。{stem} は
#                              # kebab-case/snake_case 両方の候補が展開される。
#                              # absent_sibling と併記した場合は OR で判定する
#
#   - event: stop_check        # Stop 時、そのセッションの変更ファイルを検査
#     changed: 'glob'          # 必須。worktree 内のファイルは worktree ルート相対で判定する
#     check: 'shell cmd'       # 任意。$FILE に該当ファイルの絶対パスが入る。非0で違反。
#                              # cwd はそのファイルのルート（worktree 内なら worktree、それ以外は project_dir）
#     require_sibling: 'name'  # 任意。同ディレクトリにこのファイルが無ければ違反
#     message: '...'
#
# glob の解釈（* は / を跨がない、** は跨ぐ、{a,b} 展開）は scripts/stop-gate.py の
# glob_to_regex / expand_braces / compile_globs と同じ挙動。stop-gate.py 自体は変更せず、
# 必要な分をこのファイルに複製している。
#
# severity の自動決定（明示があればそれを優先）:
#   count >= 5   -> deny
#   count 3, 4   -> ask（pre_bash / pre_edit） / block（stop_check）
#   count 1, 2   -> warn
import glob
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from shutil import which

# ---- テストからモンキーパッチできるよう、モジュール属性として公開しておく ----
which = which


def feedback_dir():
    """~/.claude/feedback を返す。CLAUDE_FEEDBACK_DIR でテスト時に差し替え可能。"""
    override = os.environ.get("CLAUDE_FEEDBACK_DIR")
    if override:
        return override
    home = os.environ.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".claude", "feedback")


def violations_log_path():
    return os.path.join(feedback_dir(), ".violations.jsonl")


# ---- glob -> regex（stop-gate.py と同じ挙動。* は / を跨がない / ** は跨ぐ / {a,b} 展開） ----
def _split_top_commas(s):
    parts, depth, cur = [], 0, []
    for c in s:
        if c == "{":
            depth += 1
            cur.append(c)
        elif c == "}":
            depth -= 1
            cur.append(c)
        elif c == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
    parts.append("".join(cur))
    return parts


def expand_braces(s):
    depth, start = 0, -1
    for i, c in enumerate(s):
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                pre, inner, post = s[:start], s[start + 1 : i], s[i + 1 :]
                out = []
                for part in _split_top_commas(inner):
                    out.extend(expand_braces(pre + part + post))
                return out
    return [s]


def glob_to_regex(pat):
    i, n, out = 0, len(pat), ["^"]
    while i < n:
        c = pat[i]
        if c == "*":
            j = i
            while j < n and pat[j] == "*":
                j += 1
            if j - i >= 2:  # **
                if j < n and pat[j] == "/":
                    out.append("(?:.*/)?")
                    i = j + 1
                else:
                    out.append(".*")
                    i = j
            else:  # *
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            j = i + 1
            if j < n and pat[j] in "!^":
                j += 1
            if j < n and pat[j] == "]":
                j += 1
            while j < n and pat[j] != "]":
                j += 1
            cls = pat[i : j + 1]
            if cls.startswith("[!"):
                cls = "[^" + cls[2:]
            out.append(cls)
            i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    out.append("$")
    return "".join(out)


def compile_globs(patterns):
    rxs = []
    for pat in patterns:
        for ex in expand_braces(pat):
            rxs.append(re.compile(glob_to_regex(ex)))
    return rxs


def relativize(p, project_dir):
    rp = p
    if os.path.isabs(p):
        try:
            rp = os.path.relpath(p, project_dir)
        except ValueError:
            rp = p
    if rp.startswith("./"):
        rp = rp[2:]
    return rp


def split_root(project_dir, path):
    """path（絶対 or project_dir 相対）の実パスが
    <project_dir>/.claude/worktrees/<name>/ 配下なら (そのworktreeルート絶対パス, ルート相対パス) を
    返す。配下でなければ (project_dir, project_dir相対パス)。stop-gate.py の split_root と同じ
    判定だが、feedback_rules.py は独立モジュールなので import せず自前実装している。"""
    worktrees_dir = os.path.normpath(os.path.join(project_dir, ".claude", "worktrees"))
    abs_path = os.path.normpath(path if os.path.isabs(path) else os.path.join(project_dir, path))
    rel_to_wt = os.path.relpath(abs_path, worktrees_dir)
    if rel_to_wt != "." and not (rel_to_wt == ".." or rel_to_wt.startswith(".." + os.sep)):
        name, _, rest = rel_to_wt.partition(os.sep)
        return os.path.normpath(os.path.join(worktrees_dir, name)), rest.replace(os.sep, "/")
    return project_dir, relativize(path, project_dir)


# ---- 最小限の自前 YAML パーサ（frontmatter の subset のみ対応） ----
def _indent_of(line):
    return len(line) - len(line.lstrip(" "))


def _mini_yaml_scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if s in ("true", "True"):
        return True
    if s in ("false", "False"):
        return False
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return s


def _is_plain_scalar_seq_item(content):
    """シーケンス項目の中身が、ネストしたマッピング/シーケンスではなく単一のスカラー値
    （引用符付き文字列や ':' を含まない値）かどうかを判定する。"""
    if content.startswith("- "):
        return False
    if len(content) >= 2 and content[0] in ("'", '"') and content[-1] == content[0]:
        return True
    return ":" not in content


def _mini_yaml_parse_block(lines, idx, min_indent):
    """lines: 空行を除いた行のリスト。idx から始まる、インデントが min_indent 以上の
    ブロックを1つ読み、(値, 次のidx) を返す。先頭が '- ' ならシーケンス、それ以外はマッピング。"""
    if idx >= len(lines) or _indent_of(lines[idx]) < min_indent:
        return None, idx
    block_indent = _indent_of(lines[idx])
    first = lines[idx][block_indent:]
    if first.startswith("- "):
        result = []
        while (
            idx < len(lines)
            and _indent_of(lines[idx]) == block_indent
            and lines[idx][block_indent:].startswith("- ")
        ):
            content = lines[idx][block_indent:][2:]
            item_indent = block_indent + 2
            if content.strip() == "":
                idx += 1
                val, idx = _mini_yaml_parse_block(lines, idx, item_indent)
                result.append(val)
            elif _is_plain_scalar_seq_item(content):
                result.append(_mini_yaml_scalar(content))
                idx += 1
            else:
                synth = [(" " * item_indent) + content]
                idx += 1
                while idx < len(lines) and _indent_of(lines[idx]) >= item_indent:
                    synth.append(lines[idx])
                    idx += 1
                val, _ = _mini_yaml_parse_block(synth, 0, item_indent)
                result.append(val)
        return result, idx
    else:
        result = {}
        while (
            idx < len(lines)
            and _indent_of(lines[idx]) == block_indent
            and not lines[idx][block_indent:].startswith("- ")
        ):
            line = lines[idx][block_indent:]
            key, sep, rest = line.partition(":")
            if not sep:
                idx += 1
                continue
            key = key.strip()
            rest = rest.strip()
            idx += 1
            if rest == "":
                val, idx = _mini_yaml_parse_block(lines, idx, block_indent + 1)
                result[key] = val
            else:
                result[key] = _mini_yaml_scalar(rest)
        return result, idx


def mini_yaml_load(text):
    """PyYAML も yq も無い環境向けの必要最小限の自前パーサ。
    frontmatter の subset（トップレベルのマッピング + ネストしたリスト/マッピング、
    単一引用符/二重引用符スカラー）のみサポートする。"""
    lines = [l for l in text.split("\n") if l.strip() != ""]
    if not lines:
        return {}
    val, _ = _mini_yaml_parse_block(lines, 0, _indent_of(lines[0]))
    return val or {}


def load_yaml_text(text):
    """PyYAML があれば使い、無ければ yq、どちらも無ければ mini_yaml_load にフォールバックする
    （stop-gate.py の load_action と同じ思想）。"""
    try:
        import yaml

        return yaml.safe_load(text)
    except ImportError:
        pass
    if which("yq"):
        try:
            r = subprocess.run(
                ["yq", "-o=json", "."], input=text, capture_output=True, text=True, timeout=10
            )
            if r.returncode == 0:
                return json.loads(r.stdout)
        except Exception:
            pass
    return mini_yaml_load(text)


# ---- frontmatter 読み込み ----
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?\n)---\s*\n?", re.DOTALL)
BODY_STOP_RE = re.compile(r"\*\*(Why|言い訳|How to apply)[:：]?\*\*")


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def load_rule(path):
    """1つの feedback ファイルから frontmatter を読む。frontmatter が無ければ None
    （rules.md はこれで黙ってスキップされる）。"""
    content = _read_text(path)
    if content is None:
        return None
    m = FRONTMATTER_RE.match(content)
    if not m:
        return None
    data = load_yaml_text(m.group(1))
    if not isinstance(data, dict) or not data.get("name"):
        return None
    try:
        count = int(data.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    return {
        "name": data.get("name"),
        "description": data.get("description") or "",
        "count": count,
        "enforce": data.get("enforce") or [],
        "path": path,
    }


def load_body_intro(path):
    """ルール本文のうち、**Why:** / **言い訳:** / **How to apply:** より前の
    第1段落（最初の空行まで）を返す。"""
    content = _read_text(path)
    if content is None:
        return ""
    m = FRONTMATTER_RE.match(content)
    body = content[m.end() :] if m else content
    stop = BODY_STOP_RE.search(body)
    lead = body[: stop.start()] if stop else body
    lead = lead.strip()
    if not lead:
        return ""
    return lead.split("\n\n", 1)[0].strip()


def list_rules(feedback_dir_path=None):
    """feedback ディレクトリ配下の *.md を全件走査し、frontmatter を持つものだけ返す。"""
    d = feedback_dir_path or feedback_dir()
    rules = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return rules
    for name in names:
        if not name.endswith(".md"):
            continue
        rule = load_rule(os.path.join(d, name))
        if rule:
            rules.append(rule)
    return rules


# ---- severity 解決 ----
def resolve_severity(count, explicit=None, event=None):
    """ルールに severity の明示があればそれを使い、無ければ count から決める。
    count>=5 -> deny / count 3,4 -> ask（pre_*）・block（stop_check） / count 1,2 -> warn。"""
    if explicit:
        return explicit
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = 0
    if count >= 5:
        return "deny"
    if count >= 3:
        return "block" if event == "stop_check" else "ask"
    return "warn"


# ---- 違反ログ ----
def log_violation(rule, count, severity, event, detail):
    """~/.claude/feedback/.violations.jsonl に1行 JSON を追記する。
    count 自体は絶対に書き換えない（ログに残すのみ）。ログ失敗で hook を止めないよう
    例外は握りつぶす。"""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "rule": rule,
        "count": count,
        "severity": severity,
        "event": event,
        "detail": detail,
    }
    try:
        path = violations_log_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ---- pre_edit: テストファイル自身の自己参照を防ぐ ----
def _looks_like_test_file(basename):
    if re.search(r"_test\.go$", basename):
        return True
    if re.search(r"\.(test|spec)\.tsx?$", basename):
        return True
    if re.search(r"_(spec|test)\.rb$", basename):
        return True
    if re.match(r"^test_.*\.py$", basename) or re.search(r"_test\.py$", basename):
        return True
    return False


def _stem_variants(stem):
    """kebab-case / snake_case の表記ゆれを吸収するため、stem 自身に加えて
    '-' <-> '_' を入れ替えた候補を返す（重複排除、元の stem が先頭）。"""
    variants = [stem]
    if "-" in stem:
        alt = stem.replace("-", "_")
        if alt not in variants:
            variants.append(alt)
    if "_" in stem:
        alt = stem.replace("_", "-")
        if alt not in variants:
            variants.append(alt)
    return variants


def _stem_brace(stem):
    variants = _stem_variants(stem)
    if len(variants) == 1:
        return variants[0]
    return "{" + ",".join(variants) + "}"


def _expand_stem(pattern, path):
    """{stem} を kebab-case/snake_case 双方の候補に展開し、マッチする全候補文字列を返す。"""
    stem = os.path.splitext(os.path.basename(path))[0]
    return expand_braces(pattern.replace("{stem}", _stem_brace(stem)))


def _expand_test_pattern(pattern, rel_path):
    """absent_glob の {stem}（拡張子抜きファイル名、kebab/snake 両対応）と
    {dir}（プロジェクト相対ディレクトリ）を展開する。ルート直下のファイルでは {dir} を
    "." にして glob が壊れないようにする。呼び出し側で expand_braces() にかける前提。"""
    stem = os.path.splitext(os.path.basename(rel_path))[0]
    return pattern.replace("{stem}", _stem_brace(stem)).replace(
        "{dir}", os.path.dirname(rel_path) or "."
    )


def extract_pre_edit_content(tool_name, tool_input):
    """Edit/Write/MultiEdit の tool_input から検査対象の文字列を取り出す。"""
    if tool_name == "Write":
        return tool_input.get("content") or ""
    if tool_name == "Edit":
        return tool_input.get("new_string") or ""
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits") or []
        return "\n".join(e.get("new_string") or "" for e in edits if isinstance(e, dict))
    return ""


# ---- enforce 評価: pre_bash ----
def eval_pre_bash(rules, command, project_dir=None):
    project_dir = project_dir or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    violations = []
    if not command:
        return violations
    for rule in rules:
        for entry in rule.get("enforce") or []:
            if entry.get("event") != "pre_bash":
                continue
            when = entry.get("when")
            if not when or not re.search(when, command):
                continue
            unless = entry.get("unless")
            if unless and re.search(unless, command):
                continue
            check_cmd = entry.get("check")
            if check_cmd:
                try:
                    r = subprocess.run(
                        check_cmd, shell=True, cwd=project_dir,
                        capture_output=True, text=True, timeout=10,
                    )
                    if r.returncode == 0:
                        continue  # 非0終了で違反確定。0終了なら違反ではない
                except Exception:
                    pass  # check 自体が動かせない場合は when 一致のみで違反扱いにする
            severity = resolve_severity(rule["count"], entry.get("severity"), event="pre_bash")
            violations.append(
                {
                    "rule": rule["name"],
                    "count": rule["count"],
                    "severity": severity,
                    "event": "pre_bash",
                    "message": entry.get("message") or "",
                    "detail": f"command matched: {when}",
                }
            )
    return violations


# ---- enforce 評価: pre_edit ----
def eval_pre_edit(rules, file_path, content, project_dir=None):
    project_dir = project_dir or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    root, rel = split_root(project_dir, file_path)
    basename = os.path.basename(file_path)
    content = content or ""
    violations = []
    for rule in rules:
        for entry in rule.get("enforce") or []:
            if entry.get("event") != "pre_edit":
                continue
            pat = entry.get("path")
            patterns = [pat] if isinstance(pat, str) else (pat or [])
            if not patterns:
                continue
            rxs = compile_globs(patterns)
            if not any(rx.match(rel) for rx in rxs):
                continue

            excl = entry.get("exclude_path")
            excl_patterns = [excl] if isinstance(excl, str) else (excl or [])
            if excl_patterns and any(rx.match(rel) for rx in compile_globs(excl_patterns)):
                continue

            absent_sibling = entry.get("absent_sibling")
            ag = entry.get("absent_glob")
            absent_globs = [ag] if isinstance(ag, str) else (ag or [])
            if absent_sibling or absent_globs:
                if _looks_like_test_file(basename):
                    continue  # テストファイル自身は対象外
                candidates, found = [], False
                if absent_sibling:
                    sib_names = _expand_stem(absent_sibling, file_path)
                    candidates.extend(sib_names)
                    found = any(
                        os.path.exists(os.path.join(os.path.dirname(file_path), sib_name))
                        for sib_name in sib_names
                    )
                for pat in absent_globs:
                    if found:
                        break
                    for expanded in expand_braces(_expand_test_pattern(pat, rel)):
                        candidates.append(expanded)
                        if glob.glob(os.path.join(root, expanded), recursive=True):
                            found = True
                            break
                if found:
                    continue
                detail = f"missing test file: {', '.join(candidates)}"
            else:
                when = entry.get("when")
                if not when or not re.search(when, content, re.MULTILINE):
                    continue
                unless = entry.get("unless")
                if unless and re.search(unless, content, re.MULTILINE):
                    continue
                detail = f"content matched: {when}"

            severity = resolve_severity(rule["count"], entry.get("severity"), event="pre_edit")
            violations.append(
                {
                    "rule": rule["name"],
                    "count": rule["count"],
                    "severity": severity,
                    "event": "pre_edit",
                    "message": entry.get("message") or "",
                    "detail": detail,
                }
            )
    return violations


# ---- enforce 評価: stop_check ----
def _read_lines(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return None


def _git_fallback_files(cwd):
    files = set()
    for args in (
        ["git", "diff", "--name-only", "HEAD"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ):
        try:
            r = subprocess.run(
                args, cwd=cwd, capture_output=True, text=True, timeout=10
            )
            if r.returncode == 0:
                files.update(l.strip() for l in r.stdout.splitlines() if l.strip())
        except Exception:
            pass
    return sorted(files)


def get_changed_files(project_dir, session_id, agent_id=None):
    """record-changes.sh が書く changed_files.<state_id>.txt を優先して読む。
    このファイルは gate.yaml を持つプロジェクトでしか作られないため、無ければ git で
    フォールバックする。gate 側が成功時にメモを消費するため、フォールバック経路は必須。

    agent_id 指定時（サブエージェントの Stop）は changed_files.<session>--<agent>.txt だけを
    読む。メモが無ければ、そのエージェントの worktree（.claude/worktrees/agent-<agent_id>）が
    あればそこを cwd に git フォールバックし、worktree ルートを付けた絶対パスで返す
    （worktree 相対のまま返すとメインのプロジェクト相対パスと誤認されるため）。worktree が
    無ければ project_dir で git フォールバックする。

    agent_id 未指定（メインの Stop）は changed_files.<session>.txt に加え、
    changed_files.<session>--*.txt を全部読んで順序を保ってマージ・重複排除する。メモが
    1つも無いときだけ project_dir で git フォールバックする（従来どおりの挙動）。"""
    claude_dir = os.path.join(project_dir, ".claude")
    state_dir = os.path.join(claude_dir, ".gate-status")

    if agent_id:
        memo = os.path.join(state_dir, f"changed_files.{session_id}--{agent_id}.txt")
        lines = _read_lines(memo)
        if lines is not None:
            return lines
        worktree = os.path.join(claude_dir, "worktrees", f"agent-{agent_id}")
        if os.path.isdir(worktree):
            return [os.path.join(worktree, f) for f in _git_fallback_files(worktree)]
        return _git_fallback_files(project_dir)

    memo = os.path.join(state_dir, f"changed_files.{session_id}.txt")
    seen = set()
    merged = []
    found_any = False
    plain_lines = _read_lines(memo)
    if plain_lines is not None:
        found_any = True
        for l in plain_lines:
            if l not in seen:
                seen.add(l)
                merged.append(l)
    agent_memo_pattern = os.path.join(state_dir, f"changed_files.{session_id}--*.txt")
    for path in sorted(glob.glob(agent_memo_pattern)):
        found_any = True
        for l in _read_lines(path) or []:
            if l not in seen:
                seen.add(l)
                merged.append(l)
    if found_any:
        return merged
    return _git_fallback_files(project_dir)


def eval_stop_check(rules, project_dir, changed_files_list):
    keyed = [split_root(project_dir, f) for f in changed_files_list]
    violations = []
    for rule in rules:
        for entry in rule.get("enforce") or []:
            if entry.get("event") != "stop_check":
                continue
            pat = entry.get("changed")
            patterns = [pat] if isinstance(pat, str) else (pat or [])
            if not patterns:
                continue
            rxs = compile_globs(patterns)
            matched = sorted({(root, rel) for root, rel in keyed for rx in rxs if rx.match(rel)})
            if not matched:
                continue

            check_cmd = entry.get("check")
            require_sibling = entry.get("require_sibling")
            bad_files = []
            for root, rel in matched:
                abs_path = os.path.join(root, rel)
                bad = False
                if require_sibling:
                    sib_names = _expand_stem(require_sibling, abs_path)
                    if not any(
                        os.path.exists(os.path.join(os.path.dirname(abs_path), sib_name))
                        for sib_name in sib_names
                    ):
                        bad = True
                if check_cmd:
                    try:
                        r = subprocess.run(
                            check_cmd, shell=True, cwd=root,
                            env={**os.environ, "FILE": abs_path},
                            capture_output=True, text=True, timeout=15,
                        )
                        if r.returncode != 0:
                            bad = True
                    except Exception:
                        bad = True
                if bad:
                    label = rel if root == project_dir else f"{os.path.basename(root)}/{rel}"
                    bad_files.append(label)

            if bad_files:
                severity = resolve_severity(rule["count"], entry.get("severity"), event="stop_check")
                violations.append(
                    {
                        "rule": rule["name"],
                        "count": rule["count"],
                        "severity": severity,
                        "event": "stop_check",
                        "message": entry.get("message") or "",
                        "detail": f"changed files violating: {', '.join(bad_files)}",
                    }
                )
    return violations
