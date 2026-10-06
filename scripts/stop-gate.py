#!/usr/bin/env python3
"""gate hook 本体（stop-gate.py という名前だが PostToolUse からも呼ばれる）。
action.yaml の glob ルールに従い、変更ファイルに対応するコマンドを実行する。

二相構造:
  - rules フェーズ（PostToolUse、CLAUDE_GATE_PHASE=rules）: マッチしたルールの run
    だけを実行する。ブロックしない（PostToolUse の exit 2 はツール実行後の stderr
    フィードバックであり、会話は止まらない）。マッチしたルールが run_checks で
    参照した consistency_checks の名前を、checks フェーズが後で実行するための
    「予約」として永続化する。
  - checks フェーズ（Stop / SubagentStop、CLAUDE_GATE_PHASE=checks、デフォルト）:
    予約された consistency_checks だけを実行する。rules は実行しない。失敗なら
    exit 2 で会話の終了をブロックし、MAX_ATTEMPTS で打ち切る。

予約が空（何も rules フェーズでマッチしなかった）なら checks フェーズは即 exit 0。
run_checks を持たないルールで通ったファイルは、それ以上待つものが無いので rules
フェーズの時点で完了扱いになり、CHANGED からも SIDECAR からも外れる。以後その
ファイルが別の変更で壊れても検出されない（run_checks がパッケージ跨ぎ検証の
唯一の手段）。

# 状態ファイル（CHANGED/COUNT/SIDECAR/PENDING/ログディレクトリ）の ID は、CLAUDE_AGENT_ID
# が設定されていれば "<session_id>--<agent_id>"、無ければ session_id そのもの。
# changed_files の各行は実パスが <PROJECT_DIR>/.claude/worktrees/<name>/ 配下なら
# そのディレクトリを「ルート」として扱い、ルートごとに cwd とそのルート自身の
# .claude/gate.yaml（無ければメインの cfg にフォールバック）で独立にチェックする。
# worktree が既に消えている場合は警告して対象から外す。予約（PENDING）もルート単位で
# 持つ（あるルートの rule がマッチして予約した check を、別のルートで実行してはいけない）。
#
# rule は通ったが consistency_checks の確認待ちのファイルは changed_files から間引き
# gate_passed.<state_id>.txt (SIDECAR) へ退避する。checks フェーズで対応する
# consistency_checks が全て成功したら SIDECAR から確定除去する。失敗し MAX_ATTEMPTS で
# 諦めたときは、黙って確認済み扱いにはせず CHANGED へ戻す（次の編集で rules フェーズが
# 再度拾えるようにするため）。

# match:       glob（文字列 or リスト）。* は / を跨がない、** は跨ぐ、{a,b} 展開可。
# dir:         コマンドを実行する作業ディレクトリ（省略時はプロジェクトルート）。
#              per_file_dir が設定されているときは無視される。
# per_file_dir: dir を無視し、match にマッチした各ファイルからルートを決めて、ルート
#              ごとに run を実行する（ルート単位で重複排除、実行順はルート名の昇順）。
#              値は true / "file" / "pattern_root" のいずれか（true は "file" の別名）。
#              - "file"（true と同義）: マッチした各ファイル自身のディレクトリ
#                （os.path.dirname）をルートにする。match のパターン文字列（** の位置）
#                は一切見ない。ディレクトリ＝パッケージという構成（Go の1ディレクトリ
#                1パッケージなど）向け。
#                例: match: "pkg/**/*.go" / per_file_dir: true なら、
#                pkg/services/chat/x.go と pkg/services/chat/y_test.go がマッチしたとき
#                どちらも同じルート pkg/services/chat にまとまり run は1回だけ実行
#                される。pkg/domain/user/z.go は別ルート pkg/domain/user で実行される。
#              - "pattern_root": マッチしたパターンの最初の ** セグメントの直前までに
#                対応する実パス部分をルートにする（** を含まないパターンではファイル
#                自身の dirname にフォールバック）。ネストした階層のファイルを触っても
#                package.json / pyproject.toml があるパッケージルートでまとめて実行
#                したい構成（pnpm workspace 等）向け。
#                例: match: "services/*/**/*.py" / per_file_dir: "pattern_root" なら、
#                services/foo/src/utils/helper.py を触っても、"*" セグメントの直前
#                である services/foo をルートとして run が実行される。
#              上記以外の値（false・未設定を含む）は per_file_dir を使わない指定として
#              扱われるが、true/false のいずれでもない不正な文字列が指定された場合は
#              ルールをスキップした上で rules フェーズを失敗扱いにする（黙って無視しない）。
# run:         マッチしたとき実行するコマンド列。1つでも非0なら失敗＝rules フェーズ
#              では stderr 通知（会話は止めない）、checks フェーズでは停止をブロック。
#              各要素は文字列、{cmd: "...", name: "...", timeout: N} 形式、または
#              {parallel: [...]} 形式。timeout はそのコマンドのタイムアウト秒数
#              （省略時 300 秒）。超過したらプロセスグループごと SIGKILL して失敗扱い。
#              rule / consistency_check レベルの timeout: はデフォルト値になる。
#              name はログファイル名に使う識別名（省略時は cmd から生成）。
# CLAUDE_GATE_FILES:
#              run / consistency_checks の各コマンドには、そのとき対象になっている
#              ファイルのルート相対パスが環境変数 CLAUDE_GATE_FILES で渡る。値は
#              値は shlex 引用済み・重複排除・昇順で、空白区切りの1行。
#              パスに空白が無ければ `cmd $CLAUDE_GATE_FILES` で渡せる。空白を含みうる
#              なら `eval "set -- $CLAUDE_GATE_FILES"` で位置パラメータに戻して使う。
#              rules フェーズでは、per_file_dir を使うときはそのルートに属する
#              match ファイルだけ、使わないときは rule の match ファイル全体。
#              checks フェーズでは、その consistency_check を予約したファイル全体。
#              例: docker compose exec -T app bundle exec rubocop $CLAUDE_GATE_FILES
# parallel:    run の要素として {parallel: [文字列 or {cmd, timeout}, ...]} を書くと、
#              その中のコマンドは並行実行される（全て完了してから次の要素へ進む）。
#              parallel の中に parallel はネストできない（失敗扱い）。
# policy:      dogwood のポリシーファイル（.dw）のパス。トップレベルに書くと全ルール /
#              全 consistency_checks の既定値になり、rules[] / consistency_checks[] 側に
#              書くとそのルールだけ上書きする。root_dir（PROJECT_DIR または worktree
#              ルート）からの相対パス（絶対パスと ~ 展開も可）。設定されている間は run の
#              各コマンドを実行前に dogwood replay で判定し、deny なら実行せず控えに積む。
#              スキップは失敗ではない（success_files の扱いは成功時と同じ）。
#              未設定なら同梱の既定ポリシー scripts/dogwood/gate.default.dw が適用される。
#              false を書くと判定せず従来どおり毎回実行する（rules[] / consistency_checks[]
#              側の false はトップレベルのパス指定を打ち消す）。パスを明示したのにその
#              ファイルが存在しない場合は、既定へフォールバックせず判定を無効にしてログを
#              出す（設定ミスを黙って埋めないため）。
#              ポリシーはあるのに replay が非0・出力が壊れている場合、そのコマンドは実行せず
#              控えに積む。dogwood が見つからない場合も同じだが、既定ポリシー（policy: を
#              書いていない）のときだけは従来どおり実行する（dogwood 未導入の環境で全コマンド
#              が黙って止まるのを避けるため）。
# policy_schema: policy の検証に使う Cedar スキーマ（.cedarschema）のパス。省略時は同梱の
#              scripts/dogwood/gate.cedarschema。ポリシーに渡る入力は name と cmd の2つだけ
#              （name は {cmd, name} の name、省略時は cmd から生成した識別名）。
#
# ポリシー判定の実行履歴は ${PROJECT_DIR}/.claude/.gate-status/gate_trace.{state_id}.jsonl に、
# スキップしたコマンドの控えは同じ場所の gate_deferred.{state_id}.json に溜まる。控えは
# rules フェーズで allow されたコマンドが1つでも実行された回に、ポリシー判定をバイパス
# して消化される（判定をかけると失敗が続いている間は永久に消化されないため）。ただし
# 消化されるのはその回が始まる前から控えにあった分だけで、同じ回の中で新しく積まれた
# 分（allow されて控えから外れた後、同じ cwd・同じ cmd を参照する別ルールの評価で
# 再度 deny されて積み直された分を含む）は次回以降に持ち越される。checks フェーズ
# （Stop / SubagentStop）では、その回が始まる前から
# あった控えを全件消化し、失敗した分は控えに戻して停止をブロックする。各プロジェクトの .gitignore には
# .claude/.gate-status/ を足すこと。
#
# 各コマンドの stdout/stderr は実行中も含めて
# ${PROJECT_DIR}/.claude/.gate-status/logs/{state_id}/{name もしくは cmd}.{pid}.log に
# リアルタイムで書き出される（tee 相当）。長時間コマンドは tail -f で進捗を追える。
# フック起動時に自動削除: 現セッションのログは1時間（LOG_MAX_AGE）超で、
# 過去セッションのログは最終書き込みから5分（LOG_STALE_GRACE）超で消える。
# run_checks:  このルールがマッチしたとき、rules フェーズが checks フェーズへ予約する
#              consistency_checks の名前一覧。実際に実行されるのは checks フェーズ
#              （Stop/SubagentStop）で、マッチしたルールが参照した名前だけが動く。
#              無関係な pkg のチェックは走らない。同じ名前を複数ルールが参照しても
#              1回のチェック実行につき1回だけ実行される。
# consistency_checks: name/dir/run を持つ名前付きチェック定義集（match は持たない）。
#              checks フェーズでしか実行されない。
rules:
  - match: "packages/api/**/*.go"
    dir: packages/api
    run:
      - go vet ./...
      - cmd: go test ./...
        name: api-test          # ログは api-test.{pid}.log になる
    run_checks: [go-build]

  - match: "packages/worker/**/*.go"
    dir: packages/worker
    run:
      - go vet ./...
      - go test ./...
    run_checks: [go-build]          # api と同じ整合性チェックを共有

  - match:
      - "apps/web/**/*.{ts,tsx}"
      - "apps/web/**/*.css"
    dir: apps/web
    run:
      - pnpm lint
      - pnpm test --run

  - match: "services/*/**/*.py"    # services直下の各サービスだけ（*は1階層）
    run:
      - ruff check .
      - pytest -q

  - match: "**/*.md"               # ドキュメントだけならリンクチェックのみ、など
    run:
      - echo "docs changed (no test)"

consistency_checks:
  - name: go-build                 # go 系のルールがマッチしたときだけ予約される全体ビルド
    run:
      - go build ./...
"""
import contextlib, fcntl, os, sys, json, shlex, subprocess, re, signal, tempfile, time, traceback
from concurrent.futures import ThreadPoolExecutor
from shutil import which

PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
SESSION_ID  = os.environ.get("CLAUDE_SESSION_ID") or "unknown"
AGENT_ID    = os.environ.get("CLAUDE_AGENT_ID") or ""
STATE_ID    = f"{SESSION_ID}--{AGENT_ID}" if AGENT_ID else SESSION_ID
WORKTREES_DIR = os.path.normpath(os.path.join(PROJECT_DIR, ".claude", "worktrees"))
# rules（PostToolUse）/ checks（Stop・SubagentStop）のどちらのフェーズとして起動されたか。
# 未指定時は checks（この hook の唯一の呼び出し元が長らく Stop だったため、デフォルトも
# それに合わせる。PostToolUse から呼ぶ側は stop-test-gate.sh が必ず rules を明示する）。
PHASE = (os.environ.get("CLAUDE_GATE_PHASE") or "checks").strip().lower()
# 前回の Stop hook がブロックして継続させた結果の Stop なら true（stop-test-gate.sh が
# stdin の stop_hook_active から渡す）。false ならユーザーの新しいターン起点の Stop。
# checks フェーズの MAX_ATTEMPTS リトライ回数リセット判定にのみ使う。
STOP_HOOK_ACTIVE = (os.environ.get("CLAUDE_STOP_HOOK_ACTIVE") or "").strip().lower() == "true"
CLAUDE_DIR  = os.path.join(PROJECT_DIR, ".claude")
ACTION      = os.path.join(CLAUDE_DIR, "gate.yaml")
GATE_YML    = os.path.join(CLAUDE_DIR, "gate.yml")  # 拡張子 typo 検知用
STATE_DIR   = os.path.join(CLAUDE_DIR, ".gate-status")  # 状態ファイルとログの置き場所（gate.yaml は動かさない）
CHANGED     = os.path.join(STATE_DIR, f"changed_files.{STATE_ID}.txt")
COUNT       = os.path.join(STATE_DIR, f"gate_attempts.{STATE_ID}.txt")
SIDECAR     = os.path.join(STATE_DIR, f"gate_passed.{STATE_ID}.txt")  # rule通過・checks確認待ち
PENDING     = os.path.join(STATE_DIR, f"gate_pending_checks.{STATE_ID}.json")  # checksフェーズへの予約
TRACE       = os.path.join(STATE_DIR, f"gate_trace.{STATE_ID}.jsonl")   # ポリシー判定に食わせる実行履歴
DEFERRED    = os.path.join(STATE_DIR, f"gate_deferred.{STATE_ID}.json") # ポリシーでスキップした分の控え
LOG_ROOT    = os.path.join(STATE_DIR, "logs")
LOG_DIR     = os.path.join(LOG_ROOT, STATE_ID)
MAX_ATTEMPTS = 5
DEFAULT_TIMEOUT = 300   # 秒。rule / consistency_check の timeout: で上書き可
LOG_MAX_AGE = 3600      # 秒。現セッションのログでもこれより古ければ削除
LOG_STALE_GRACE = 300   # 秒。他セッションのログは最終書き込みからこれだけ経てば削除
                        # （並行実行中の別セッションの書き込み中ログを守るための猶予）
HOOKS_DIR   = os.path.dirname(os.path.abspath(__file__))
DEFAULT_POLICY = os.path.join(HOOKS_DIR, "dogwood", "gate.default.dw")
DEFAULT_POLICY_SCHEMA = os.path.join(HOOKS_DIR, "dogwood", "gate.cedarschema")
DOGWOOD_BIN = os.environ.get("DOGWOOD_BIN") or ""
DOGWOOD_FALLBACKS = ("~/.cargo/bin/dogwood", "~/.local/share/mise/shims/dogwood")
GATE_PRINCIPAL = 'Gate::Agent::"gate"'
# run のコマンドへ「今回 match した対象ファイル」を渡す環境変数名。
FILES_ENV_KEY = "CLAUDE_GATE_FILES"
TRACE_WINDOW = 86400    # 秒。dogwood の時間窓の上限（既定 24h）を超えた履歴は判定に使えない
POLICY_TIMEOUT = 30     # 秒。dogwood replay 自体のタイムアウト

def cleanup(only=None):
    """状態ファイルを削除する。only を渡すと、その集合だけを消す
    （MAX_ATTEMPTS 到達時、CHANGED と SIDECAR は未検証の記録として
    残す必要があるため、COUNT と PENDING だけを消す経路として使う）。"""
    for f in (only if only is not None else (CHANGED, COUNT, SIDECAR, PENDING)):
        try: os.remove(f)
        except FileNotFoundError: pass

# ---- glob -> regex（* は / を跨がない / ** は跨ぐ / {a,b} 展開 / ? / [..]） ----
def _split_top_commas(s):
    parts, depth, cur = [], 0, []
    for c in s:
        if c == "{": depth += 1; cur.append(c)
        elif c == "}": depth -= 1; cur.append(c)
        elif c == "," and depth == 0: parts.append("".join(cur)); cur = []
        else: cur.append(c)
    parts.append("".join(cur))
    return parts

def expand_braces(s):
    depth, start = 0, -1
    for i, c in enumerate(s):
        if c == "{":
            if depth == 0: start = i
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                pre, inner, post = s[:start], s[start+1:i], s[i+1:]
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
            while j < n and pat[j] == "*": j += 1
            if j - i >= 2:                       # **
                if j < n and pat[j] == "/":
                    out.append("(?:.*/)?"); i = j + 1   # **/ は 0 階層も許可
                else:
                    out.append(".*"); i = j
            else:                                # *
                out.append("[^/]*"); i += 1
        elif c == "?":
            out.append("[^/]"); i += 1
        elif c == "[":
            j = i + 1
            if j < n and pat[j] in "!^": j += 1
            if j < n and pat[j] == "]": j += 1
            while j < n and pat[j] != "]": j += 1
            cls = pat[i:j+1]
            if cls.startswith("[!"): cls = "[^" + cls[2:]
            out.append(cls); i = j + 1
        else:
            out.append(re.escape(c)); i += 1
    out.append("$")
    return "".join(out)

def match_patterns(pats):
    """パターン文字列のリストをブレース展開し、(展開後パターン文字列, コンパイル済み正規表現)
    のペアを match に書かれた順→ブレース展開順で返す。per_file_dir のルート抽出には
    展開後のパターン文字列自体が必要なので、正規表現だけを返す compile_globs とは別に持つ。"""
    pairs = []
    for pat in pats:
        for ex in expand_braces(pat):
            pairs.append((ex, re.compile(glob_to_regex(ex))))
    return pairs

def compile_globs(patterns):
    return [rx for _, rx in match_patterns(patterns)]

# ---- per_file_dir のモード正規化（true/"file"/"pattern_root" -> "file"/"pattern_root"/None） ----
def normalize_per_file_dir_mode(value):
    """per_file_dir に書かれた値を "file" / "pattern_root" に正規化する。
    true は "file" の別名。それ以外の値（false・未設定・不正な文字列等）は None を返す
    （呼び出し側は None を「per_file_dir 指定なし」または「不正値」として扱う）。"""
    if value is True or value == "file":
        return "file"
    if value == "pattern_root":
        return "pattern_root"
    return None

# ---- per_file_dir: "file" のルート抽出（マッチしたファイル自身のディレクトリをルートとする） ----
def file_root(rel_path):
    """per_file_dir: "file"（true の別名）のときの実行ルート。マッチしたファイル自身の
    ディレクトリ（os.path.dirname(rel_path)）を返す。"""
    return os.path.dirname(rel_path)

# ---- per_file_dir: "pattern_root" のルート抽出（最初の ** の直前までを実パスのルートとする） ----
def pattern_root_segment_count(pattern):
    """pattern を "/" で区切ったとき、最初に現れる ** 単独セグメントの位置（0始まり）。
    ** セグメントが無ければ None（呼び出し側はマッチしたファイル自身の dirname にフォールバックする）。"""
    for i, seg in enumerate(pattern.split("/")):
        if len(seg) >= 2 and set(seg) == {"*"}:
            return i
    return None

def glob_match_root(pattern, rel_path):
    """per_file_dir: "pattern_root" のときの実行ルート。pattern の最初の ** セグメントの
    直前までに対応する rel_path のパス部分を返す。** を含まない pattern では従来通り
    dirname(rel_path)。"""
    idx = pattern_root_segment_count(pattern)
    if idx is None:
        return os.path.dirname(rel_path)
    return "/".join(rel_path.split("/")[:idx])

def compute_per_file_roots(mode, pattern_pairs, matched):
    """matched の各ファイルについて、mode に応じたルートを求める辞書を返す
    （per_file_dir のルート単位の重複排除に使う）。
    mode == "file": ファイル自身のディレクトリ（dirname）。
    mode == "pattern_root": そのファイルにマッチした最初のパターン（pattern_pairs の
    順序＝ match に書かれた順→ブレース展開順）から glob_match_root で求める。"""
    if mode == "file":
        return {rp: file_root(rp) for rp in matched}
    roots = {}
    for rp in matched:
        for pat_text, rx in pattern_pairs:
            if rx.match(rp):
                roots[rp] = glob_match_root(pat_text, rp)
                break
    return roots

# ---- YAML ロード（PyYAML 優先 → yq フォールバック） ----
class _YamlUnavailable:  # object() だと型チェッカが戻り値型を object に潰すため専用クラスにする
    pass

YAML_UNAVAILABLE = _YamlUnavailable()  # PyYAML も yq も無い場合の判別用センチネル

def load_action(path):
    with open(path) as fh: text = fh.read()
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        pass
    if which("yq"):
        r = subprocess.run(["yq", "-o=json", "."], input=text,
                           capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout)
    sys.stderr.write("[gate] YAML パーサ不在（PyYAML も yq も無し）。スキップします。\n")
    return YAML_UNAVAILABLE

def _prune_dir(dirpath, max_age, rmdir=False):
    """dirpath 直下の .log のうち mtime が max_age 秒より古いものを削除。
    rmdir=True なら空になったディレクトリ自体も削除する。"""
    try: names = os.listdir(dirpath)
    except OSError: return
    cutoff = time.time() - max_age
    for name in names:
        if not name.endswith(".log"): continue
        path = os.path.join(dirpath, name)
        try:
            if os.path.getmtime(path) < cutoff: os.remove(path)
        except OSError: pass
    if rmdir:
        try: os.rmdir(dirpath)
        except OSError: pass  # 空でない・消せない場合はそのまま

def prune_logs():
    """ログ掃除。現セッション分は LOG_MAX_AGE、他セッション分は LOG_STALE_GRACE を超えたら削除。
    実行中のログは書き込みで mtime が更新され続けるので消えない。"""
    try: entries = os.listdir(LOG_ROOT)
    except OSError: return
    for name in entries:
        path = os.path.join(LOG_ROOT, name)
        if os.path.isdir(path):
            if name == STATE_ID:
                _prune_dir(path, LOG_MAX_AGE)
            else:
                _prune_dir(path, LOG_STALE_GRACE, rmdir=True)
        elif name.endswith(".log"):
            # セッション別ディレクトリ導入前の直下ログも掃除
            try:
                if os.path.getmtime(path) < time.time() - LOG_STALE_GRACE: os.remove(path)
            except OSError: pass

def slug(cmd):
    """コマンド文字列をログファイル名に使える形へ（英数と ._- 以外を _ に、80文字まで）。"""
    return (re.sub(r"[^A-Za-z0-9._-]+", "_", cmd).strip("_.")[:80]) or "cmd"

# ---- 通過・スキップ・失敗の 1 行ログ（通ったのか実行されなかったのかを区別するため） ----
# 失敗時の詳細出力（logs）とは別に持ち、成功時は systemMessage、失敗時は stderr の先頭に出す。
STATUS = []
STATUS_CMD_MAX = 100    # 文字。1 行ログに載せるコマンドの最大長

def one_line(cmd):
    """複数行のコマンドは最初の非空行 + " ..." にし、長すぎるものは切り詰める（1 コマンド 1 行）。"""
    lines = [l.strip() for l in str(cmd).splitlines() if l.strip()]
    text = lines[0] if lines else ""
    if len(lines) > 1:
        text += " ..."
    return text if len(text) <= STATUS_CMD_MAX else text[:STATUS_CMD_MAX - 3] + "..."

def note(kind, label, cmd, detail=""):
    """`[gate] <kind>: <label> $ <cmd> <detail>` を STATUS に積む。"""
    STATUS.append(f"[gate] {kind}: {label} $ {one_line(cmd)}" + (f" {detail}" if detail else ""))

def status_block(fallback=""):
    return "\n".join(STATUS) if STATUS else fallback

# ---- dogwood ポリシー評価（コマンドを実行するかスキップするか）と、スキップ分の控え ----
@contextlib.contextmanager
def locked_file(path):
    """path を r+ で開き、flock で排他した状態のファイルハンドルを渡す（無ければ作る）。
    parallel のスレッド実行・同一セッションの PostToolUse 重複・複数セッションの同時実行が
    同じ状態ファイルを触るため、実行履歴と控えの読み書きは必ずこれで囲む。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o644), "r+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield fh
    finally:
        fh.close()  # close でロックも解放される

def _load_trace(fh):
    fh.seek(0)
    records = []
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            records.append(rec)
    return records

def _dump_trace(fh, records):
    fh.seek(0)
    fh.truncate()
    for rec in records:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    fh.flush()

def read_trace(root):
    """実行履歴のうち root のものだけを ts 昇順で返す。"""
    if not os.path.exists(TRACE):
        return []
    with locked_file(TRACE) as fh:
        records = _load_trace(fh)
    return sorted((r for r in records if r.get("root") == root), key=lambda r: r.get("ts") or 0)

def append_trace(root, cwd, name, cmd, kind):
    """実行履歴を1件追記し、書き込んだ ts を返す。dogwood のトレースは時系列順である
    必要があるので ts は root 内で単調非減少にする。書き込みのたびに TRACE_WINDOW より
    古いレコードを間引く（それより古い履歴は判定に使えない）。"""
    now = int(time.time())
    with locked_file(TRACE) as fh:
        records = _load_trace(fh)
        last = max([r.get("ts") or 0 for r in records if r.get("root") == root] or [0])
        ts = max(now, last)
        records.append({"ts": ts, "root": root, "cwd": cwd, "name": name, "cmd": cmd, "kind": kind})
        _dump_trace(fh, [r for r in records if (r.get("ts") or 0) >= now - TRACE_WINDOW])
    return ts

def _load_deferred(fh):
    fh.seek(0)
    try:
        entries = json.loads(fh.read() or "[]")
    except ValueError:
        return []
    return entries if isinstance(entries, list) else []

def _dump_deferred(fh, entries):
    fh.seek(0)
    fh.truncate()
    fh.write(json.dumps(entries, ensure_ascii=False))
    fh.flush()

def files_env(rels):
    """match したファイル（ルート相対パス）を run のコマンドへ渡す env を組み立てる。
    シェルで `for f in $CLAUDE_GATE_FILES` と単語分割して使えるよう shlex で引用する。"""
    return {FILES_ENV_KEY: " ".join(shlex.quote(r) for r in sorted(set(rels)))}

def merge_files_env(a, b):
    """2つの env の CLAUDE_GATE_FILES を和集合にする（他のキーは a を優先して残す）。"""
    rels = set()
    for env in (a, b):
        if env and env.get(FILES_ENV_KEY):
            rels |= set(shlex.split(env[FILES_ENV_KEY]))
    merged = dict(b or {}); merged.update(a or {})
    merged.update(files_env(rels))
    return merged

def defer_cmd(root, cwd, name, cmd, timeout, label, extra_env=None):
    """スキップしたコマンドを控えへ積む。(root, cwd, cmd) が同じものは積み直さないが、
    対象ファイルの env（CLAUDE_GATE_FILES）だけは既存の控えへマージする。控えを消化する
    のは後の回なので、その間に積まれた別の match ファイルを取りこぼさないため。"""
    with locked_file(DEFERRED) as fh:
        entries = _load_deferred(fh)
        key = (root, cwd, cmd)
        for e in entries:
            if (e.get("root"), e.get("cwd"), e.get("cmd")) == key:
                merged = merge_files_env(e.get("env"), extra_env)
                if merged != e.get("env"):
                    e["env"] = merged
                    _dump_deferred(fh, entries)
                return
        entries.append({"root": root, "cwd": cwd, "name": name, "cmd": cmd,
                        "timeout": timeout, "label": label, "env": extra_env or {}})
        _dump_deferred(fh, entries)

def undefer_cmd(root, cwd, cmd):
    """今から実行するコマンドが控えにも残っていれば取り除く（前回 deny された分を
    消化と実行で二重に走らせないため）。"""
    if not os.path.exists(DEFERRED):
        return
    with locked_file(DEFERRED) as fh:
        entries = _load_deferred(fh)
        key = (root, cwd, cmd)
        kept = [e for e in entries if (e.get("root"), e.get("cwd"), e.get("cmd")) != key]
        if len(kept) != len(entries):
            _dump_deferred(fh, kept)

def take_deferred():
    """控えを全件取り出して空にする。"""
    if not os.path.exists(DEFERRED):
        return []
    with locked_file(DEFERRED) as fh:
        entries = _load_deferred(fh)
        _dump_deferred(fh, [])
    return entries

def deferred_keys():
    """控えの現在の内容を (root, cwd, cmd) キーの集合として返す（消化しない）。"""
    if not os.path.exists(DEFERRED):
        return set()
    with locked_file(DEFERRED) as fh:
        entries = _load_deferred(fh)
    return {(e.get("root"), e.get("cwd"), e.get("cmd")) for e in entries}

def take_deferred_matching(keys):
    """控えのうち渡された (root, cwd, cmd) キーに一致するものだけを取り出す。
    一致しなかったエントリ（この呼び出し中に新しく積まれた分）は控えに残す。"""
    if not os.path.exists(DEFERRED):
        return []
    with locked_file(DEFERRED) as fh:
        entries = _load_deferred(fh)
        matched, kept = [], []
        for e in entries:
            key = (e.get("root"), e.get("cwd"), e.get("cmd"))
            (matched if key in keys else kept).append(e)
        if matched:
            _dump_deferred(fh, kept)
    return matched

def cedar_string(value):
    """Cedar の文字列リテラルにする。"""
    return '"' + (str(value).replace("\\", "\\\\").replace('"', '\\"')
                  .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")) + '"'

def trace_line(rec, project, index):
    """実行履歴1件を dogwood のトレース行にする。判定を生むのは request だけで、
    response / error は履歴専用イベント（verdict を生まない）。"""
    resource = "Gate::Project::" + cedar_string(project)
    payload = "{ name: %s, cmd: %s }" % (cedar_string(rec.get("name") or ""),
                                         cedar_string(rec.get("cmd") or ""))
    return ("@%d scope(principal: %s, resource: %s) request_context(input: %s) "
            'Gate::Action::"Run"::%s(input: %s, callerPrincipal: %s, callerResource: %s, '
            "requestId: %s)") % (
        int(rec.get("ts") or 0), GATE_PRINCIPAL, resource, payload,
        rec.get("kind") or "request", payload, GATE_PRINCIPAL, resource,
        cedar_string("r%d" % index))

def resolve_dogwood():
    """dogwood バイナリのパス。DOGWOOD_BIN が指定されているときは PATH へ落ちない
    （明示指定を黙って別のバイナリに置き換えないため）。見つからなければ None。"""
    if DOGWOOD_BIN:
        return DOGWOOD_BIN if os.access(DOGWOOD_BIN, os.X_OK) else None
    found = which("dogwood")
    if found:
        return found
    for candidate in DOGWOOD_FALLBACKS:
        path = os.path.expanduser(candidate)
        if os.access(path, os.X_OK):
            return path
    return None

def resolve_policy_path(root_dir, value):
    """policy / policy_schema の値を絶対パスにする（~ 展開、root_dir からの相対）。"""
    if not value:
        return None
    path = os.path.expanduser(value)
    return path if os.path.isabs(path) else os.path.normpath(os.path.join(root_dir, path))

_UNSET = object()

def inherited_setting(cfg, owner, key):
    """owner（rule / consistency_check）→ cfg（トップレベル）の順に、値ではなく
    「キーの有無」で設定値を選ぶ。false が無効化の指定なので真偽値では選べない。"""
    for src in ((owner or {}), (cfg or {})):
        if key in src:
            return src[key]
    return _UNSET

def policy_paths(cfg, owner, root_dir, logs=None):
    """(policy, policy_schema, 既定ポリシーかどうか) を解決する。owner（rule /
    consistency_check）側の指定がトップレベル（cfg）を上書きする。未設定なら同梱の
    DEFAULT_POLICY を使い、false を指定した場合と、明示したファイルが存在しない場合は
    None ＝ポリシー機構は無効で従来どおり実行する（明示指定の取りこぼしは設定ミスなので
    既定へフォールバックせずログに残す）。"""
    value = inherited_setting(cfg, owner, "policy")
    if value is False:
        return None
    is_default = value is _UNSET or value is None
    policy = DEFAULT_POLICY if is_default else resolve_policy_path(root_dir, value)
    if not policy or not os.path.exists(policy):
        if not is_default and policy and logs is not None:
            logs.append(f"=== [gate] policy に指定されたファイルが見つかりません: {policy}。"
                        "ポリシー判定を行わず実行します。 ===")
        return None
    schema = resolve_policy_path(
        root_dir, (owner or {}).get("policy_schema") or (cfg or {}).get("policy_schema"))
    return policy, (schema or DEFAULT_POLICY_SCHEMA), is_default

def dogwood_verdict(policy, schema, root_dir, name, cmd):
    """今回のコマンドの verdict を dogwood replay で求め、(verdict, None) を返す。
    dogwood には単発の許可判定コマンドが無いので、root の実行履歴をトレースへ変換し、
    末尾に今回の request を足して頭から食わせ、最後の verdict を今回の判定として使う。
    評価できなかったときは (None, 理由) を返す（呼び出し側はスキップして控えへ積む）。"""
    binpath = resolve_dogwood()
    if not binpath:
        return None, "dogwood バイナリが見つかりません（DOGWOOD_BIN / PATH / ~/.cargo/bin を確認してください）"
    history = read_trace(root_dir)
    last_ts = (history[-1].get("ts") or 0) if history else 0
    request = {"ts": max(int(time.time()), last_ts), "name": name, "cmd": cmd, "kind": "request"}
    project = os.path.basename(os.path.normpath(root_dir)) or "project"
    fd, tracefile = tempfile.mkstemp(suffix=".trace")
    try:
        with os.fdopen(fd, "w") as fh:
            for i, rec in enumerate(history + [request]):
                fh.write(trace_line(rec, project, i) + "\n")
        try:
            r = subprocess.run([binpath, "replay", policy, "--policy-schema", schema,
                                "--trace", tracefile, "--format", "json"],
                               capture_output=True, text=True, timeout=POLICY_TIMEOUT)
        except (OSError, subprocess.SubprocessError) as e:
            return None, f"dogwood の実行に失敗しました: {e}"
    finally:
        try:
            os.remove(tracefile)
        except OSError:
            pass
    if r.returncode != 0:
        detail = (r.stderr or r.stdout or "").strip().replace("\n", " ")[:200]
        return None, f"dogwood replay が異常終了しました（exit {r.returncode}）: {detail}"
    try:
        verdicts = (json.loads(r.stdout) or {}).get("verdicts") or []
    except ValueError:
        return None, "dogwood replay の出力を JSON として読めませんでした"
    if not verdicts:
        return None, "dogwood replay が verdict を返しませんでした"
    verdict = str(verdicts[-1].get("verdict") or "").lower()
    if verdict not in ("allow", "deny"):
        return None, f"dogwood replay の verdict を解釈できませんでした: {verdict!r}"
    return verdict, None

class PolicyState:
    """フェーズ1回分の共有状態。executed は「ポリシー判定の結果として実際に実行された
    コマンドがあったか」で、控えを消化してよい回かどうかの判断に使う。deferred_this_run は
    この回の中で defer_cmd() した (root, cwd, cmd) キーの集合。allow されて undefer_cmd
    された後に別ルール（同じ cwd・同じ cmd を参照する）の評価で再度 deny されて積み
    直されたキーが、この回が始まる前からのスナップショットに一致するというだけで
    消化対象になるのを防ぐ。"""
    def __init__(self):
        self.executed = False
        self.deferred_this_run = set()

class PolicyContext:
    """rule / consistency_check 1つ分のポリシー設定。"""
    def __init__(self, root_dir, policy, schema, is_default, state):
        self.root_dir = root_dir
        self.policy = policy
        self.schema = schema
        self.is_default = is_default
        self.state = state

    def allows(self, label, cwd, cmd, timeout, name, logs, extra_env=None):
        """判定して実行してよければ True。deny・評価不能ならスキップして控えへ積む。
        スキップは失敗ではないので、呼び出し側は failed を立てない。
        ただし既定ポリシー（policy: 未設定）で dogwood 自体が入っていない環境では、
        判定せず素通しする。ポリシーを設定した覚えの無い利用者の全コマンドが黙って
        止まるのを避けるため。dogwood が在るのに評価できない場合は素通ししない。"""
        if self.is_default and not resolve_dogwood():
            return True
        pname = name or slug(cmd)
        verdict, reason = dogwood_verdict(self.policy, self.schema, self.root_dir, pname, cmd)
        if verdict is None:
            logs.append(f"=== [gate] ({label}) ポリシーを評価できないため今回はスキップしました"
                        f"（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）"
                        f"［{reason}］ $ {cmd} ===")
        else:
            append_trace(self.root_dir, cwd, pname, cmd, "request")
            if verdict == "allow":
                undefer_cmd(self.root_dir, cwd, cmd)
                self.state.executed = True
                return True
            logs.append(f"=== [gate] ({label}) ポリシーにより今回はスキップしました"
                        f"（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）"
                        f" $ {cmd} ===")
        note("skip", label, cmd,
             "(ポリシー判定で見送り。控えに積んだので後で自動実行)" if verdict else
             f"(ポリシーを評価できず見送り。控えに積んだので後で自動実行: {reason})")
        self.state.deferred_this_run.add((self.root_dir, cwd, cmd))
        defer_cmd(self.root_dir, cwd, pname, cmd, timeout, label, extra_env)
        return False

    def record(self, cwd, cmd, name, ok):
        append_trace(self.root_dir, cwd, name or slug(cmd), cmd, "response" if ok else "error")

def make_policy_context(cfg, owner, root_dir, state, logs=None):
    """rule / consistency_check のポリシー設定を解決する。無効なら None を返し、
    呼び出し側は従来どおり無条件にコマンドを実行する。"""
    if state is None:
        return None
    resolved = policy_paths(cfg, owner, root_dir, logs)
    if not resolved:
        return None
    policy, schema, is_default = resolved
    return PolicyContext(root_dir, policy, schema, is_default, state)

def run_cmd(cmd, cwd, timeout, name=None, extra_env=None):
    """コマンドを実行し (output, ok, timed_out, logpath) を返す。
    stdout/stderr は tee のように LOG_DIR/{name もしくは cmd}.{pid}.log へリアルタイムで
    書き出す（実行中に tail -f で追える）。タイムアウト時はプロセスグループごと SIGKILL
    （テストが起動した子孫プロセスも道連れ）。"""
    os.makedirs(LOG_DIR, exist_ok=True)
    fd, tmppath = tempfile.mkstemp(dir=LOG_DIR, suffix=".log")
    logfh = os.fdopen(fd, "w")
    logfh.write(f"$ {cmd}  (cwd: {cwd})\n"); logfh.flush()
    env = None
    if extra_env:
        env = dict(os.environ); env.update(extra_env)
    proc = subprocess.Popen(cmd, shell=True, cwd=cwd, env=env,
                            stdout=logfh, stderr=subprocess.STDOUT,
                            start_new_session=True)
    logpath = os.path.join(LOG_DIR, f"{slug(name or cmd)}.{proc.pid}.log")
    try: os.rename(tmppath, logpath)  # fd は rename 後も有効なので書き込みは継続する
    except OSError: logpath = tmppath
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
        timed_out = True
    logfh.close()
    try:
        with open(logpath, errors="replace") as fh:
            out = "".join(fh.read().splitlines(keepends=True)[1:])  # 先頭のヘッダ行は除く
    except OSError:
        out = ""
    return out, (proc.returncode == 0 and not timed_out), timed_out, logpath

def parse_cmd(item, default_timeout):
    """run の要素（文字列 or {cmd, name, timeout}）から
    (コマンド文字列, タイムアウト秒, ログ名) を取り出す。name 省略時は None。"""
    if isinstance(item, dict):
        return (item.get("cmd") or "",
                item.get("timeout") or default_timeout,
                item.get("name") or None)
    return item, default_timeout, None

def is_parallel(item):
    return isinstance(item, dict) and "parallel" in item

# 失敗したコマンドだけの詳細（ヘッダ・出力末尾・タイムアウト文言・log パス）。成功した
# コマンドの出力は含めない。checks フェーズの block reason / 打ち切り systemMessage に載せる。
# harness が Claude に渡すのは reason だけで stderr は届かないため。
# 並列実行でも定義順になるよう、結果が揃ってから呼び出し側が積む。
FAILURES = []
FAIL_TAIL_LINES = 60        # 失敗コマンド1本あたりに載せる出力の末尾行数
FAIL_DETAIL_MAX = 12000     # 失敗詳細全体の最大文字数

class Chunk(list):
    """exec_one のログ行リスト。失敗時だけ detail（失敗詳細のテキスト）を持つ。"""
    detail = None

def tail_output(out, limit=None):
    """出力を末尾 limit 行に切り詰める。切ったときは先頭に省略表示を付ける。"""
    limit = FAIL_TAIL_LINES if limit is None else limit
    lines = out.rstrip().splitlines()
    if len(lines) <= limit:
        return "\n".join(lines)
    return "\n".join([f"…（先頭 {len(lines) - limit} 行省略）"] + lines[-limit:])

def collect_failure(chunk):
    """失敗した chunk の詳細を FAILURES に積む。呼び出し側が定義順で呼ぶ。"""
    if getattr(chunk, "detail", None):
        FAILURES.append(chunk.detail)

def failure_details():
    """FAILURES を1つの文字列にまとめる。全体が上限を超えたら残りは省略して log を見るよう促す。"""
    if not FAILURES:
        return ""
    text, used, omitted = "", 0, 0
    for i, d in enumerate(FAILURES):
        if used + len(d) + 1 > FAIL_DETAIL_MAX and used:
            omitted = len(FAILURES) - i
            break
        if used + len(d) + 1 > FAIL_DETAIL_MAX:
            d = d[:FAIL_DETAIL_MAX] + "\n…（以降省略）"
        text += d + "\n"
        used += len(d) + 1
    if omitted:
        text += f"…（残り {omitted} 件の失敗は省略。各 [gate] log のパスを見てください）\n"
    return text.rstrip()

def with_details(prefix):
    """失敗詳細があれば、見出し付きで prefix の後ろに足した文字列を返す。"""
    details = failure_details()
    return prefix + ("\n\n--- 失敗したコマンドの出力 ---\n" + details if details else "")

def exec_one(label, cmd, cwd, timeout, mark="", name=None, extra_env=None):
    """1コマンド実行して (ログ行リスト, ok) を返す。並行実行時もログを混ぜないため一旦まとめる。"""
    title = f"{name}: {cmd}" if name else cmd
    chunk = Chunk([f"=== [gate] ({label}){mark} $ {title} ==="])
    started = time.monotonic()
    out, ok, timed_out, logpath = run_cmd(cmd, cwd, timeout, name, extra_env)
    note("ok" if ok else "fail", label, cmd, f"({time.monotonic() - started:.1f}s)")
    detail = [chunk[0]]
    if out:
        chunk.append(out.rstrip())
        detail.append(tail_output(out))
    if timed_out:
        note_timeout = f"[gate] タイムアウト（{timeout}秒）で強制終了しました。無限ループやハングの可能性があります。"
        chunk.append(note_timeout)
        detail.append(note_timeout)
    if not ok:
        chunk.append(f"[gate] log: {logpath}")
        detail.append(f"[gate] log: {logpath}")
        chunk.detail = "\n".join(detail)
    return chunk, ok

def run_parallel(label, items, cwd, default_timeout, logs, policy=None, extra_env=None):
    """parallel ブロック内のコマンドを並行実行。ログは定義順で出力。失敗があれば True。
    policy を渡すと1本ずつ判定し、スキップされた分は実行対象から外れる（失敗ではない）。"""
    failed = False
    tasks = []
    for item in items:
        if is_parallel(item):
            logs.append(f"=== [gate] ({label}) parallel の中に parallel はネストできません。失敗扱いにします。 ===")
            failed = True
            continue
        cmd, timeout, name = parse_cmd(item, default_timeout)
        if not cmd: continue
        if policy and not policy.allows(label, cwd, cmd, timeout, name, logs, extra_env): continue
        tasks.append((cmd, timeout, name))
    if not tasks:
        return failed
    with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
        results = list(ex.map(
            lambda t: exec_one(label, t[0], cwd, t[1], mark=" [parallel]", name=t[2], extra_env=extra_env),
            tasks))
    for (cmd, _timeout, name), (chunk, ok) in zip(tasks, results):
        logs.extend(chunk)
        collect_failure(chunk)
        if policy: policy.record(cwd, cmd, name, ok)
        if not ok: failed = True
    return failed

def run_cmds(label, cmds, cwd, default_timeout, logs, policy=None, extra_env=None):
    """コマンド列を順に実行してログを蓄積。1つでも失敗/タイムアウトなら True を返す。
    policy を渡すと1本ずつ判定し、スキップされた分は実行対象から外れる（失敗ではない）。"""
    failed = False
    for item in cmds:
        if is_parallel(item):
            if run_parallel(label, item.get("parallel") or [], cwd, default_timeout, logs, policy, extra_env):
                failed = True
            continue
        cmd, timeout, name = parse_cmd(item, default_timeout)
        if not cmd: continue
        if policy and not policy.allows(label, cwd, cmd, timeout, name, logs, extra_env): continue
        chunk, ok = exec_one(label, cmd, cwd, timeout, name=name, extra_env=extra_env)
        logs.extend(chunk)
        collect_failure(chunk)
        if policy: policy.record(cwd, cmd, name, ok)
        if not ok: failed = True
    return failed

def run_deferred(entries, logs):
    """控えに溜まったコマンドを実行する。ここではポリシー判定をバイパスする（判定を
    かけても「失敗が続いている」状態のままなので永久に消化されない）。判定していない
    ので request は残さず、結果だけを実行履歴に残す。cwd が消えているエントリは実行
    せずに捨てる。戻り値: (summary, 失敗したエントリのリスト)。"""
    summary, failed = [], []
    for entry in entries:
        cmd, cwd = entry.get("cmd") or "", entry.get("cwd") or ""
        if not cmd:
            continue
        label = f"deferred:{entry.get('label') or '.'}"
        if not os.path.isdir(cwd):
            logs.append(f"=== [gate] ({label}) cwd が存在しません: {cwd}。この控えを破棄します。 ===")
            continue
        name = entry.get("name") or slug(cmd)
        summary.append(f"({label}) {cmd}")
        chunk, ok = exec_one(label, cmd, cwd, entry.get("timeout") or DEFAULT_TIMEOUT,
                             name=name, extra_env=entry.get("env"))
        logs.extend(chunk)
        collect_failure(chunk)
        append_trace(entry.get("root") or PROJECT_DIR, cwd, name, cmd, "response" if ok else "error")
        if not ok: failed.append(entry)
    return summary, failed

def requeue_deferred(entries):
    """失敗した控えを積み直す（次の checks フェーズ・commit / push でも消化を求めるため）。"""
    for e in entries:
        defer_cmd(e.get("root"), e.get("cwd"), e.get("name"), e.get("cmd"), e.get("timeout"),
                  e.get("label"), e.get("env"))

def summarize_cmds(cmds):
    """run_cmds は1つ失敗しても後続を実行し続ける（&& ではなく ; 相当）ので、表示もそれに合わせる。"""
    parts = []
    for c in cmds:
        if is_parallel(c):
            inner = summarize_cmds(c.get("parallel") or []).replace(" ; ", " & ")
            parts.append(f"({inner})")
        elif isinstance(c, dict):
            parts.append(c.get("cmd") or "")
        else:
            parts.append(c)
    return " ; ".join(parts)

def relativize(p):
    rp = p
    if os.path.isabs(p):
        try: rp = os.path.relpath(p, PROJECT_DIR)
        except ValueError: rp = p
    if rp.startswith("./"): rp = rp[2:]
    return rp

def split_root(raw):
    """raw の実パスが <PROJECT_DIR>/.claude/worktrees/<name>/ 配下かを判定し、
    (ルートの絶対パス, ルート相対パス) を返す。配下でなければ (PROJECT_DIR, PROJECT_DIR相対パス)。"""
    abs_path = os.path.normpath(raw if os.path.isabs(raw) else os.path.join(PROJECT_DIR, raw))
    rel_to_wt = os.path.relpath(abs_path, WORKTREES_DIR)
    if rel_to_wt != "." and not (rel_to_wt == ".." or rel_to_wt.startswith(".." + os.sep)):
        name, _, rest = rel_to_wt.partition(os.sep)
        return os.path.normpath(os.path.join(WORKTREES_DIR, name)), rest.replace(os.sep, "/")
    return PROJECT_DIR, relativize(raw)

def load_changed_flat(path):
    """path（無ければ空扱い）を読み、(root, rel) キーの出現順リストと、
    キーごとの元表記（relativize/split_root 前の raw）を返す。同じキーが複数行に
    現れたら最初の表記を優先する。CHANGED と SIDECAR の両方で使う共通ロード処理。"""
    if not os.path.exists(path):
        return [], {}
    with open(path) as fh:
        raw_lines = [l.strip() for l in fh if l.strip()]
    order, raw_by_key = [], {}
    for raw in raw_lines:
        key = split_root(raw)
        if key not in raw_by_key:
            raw_by_key[key] = raw
            order.append(key)
    return order, raw_by_key

def write_changed_flat(path, keys, raw_by_key):
    """keys（重複除去済み前提）を raw 表記で書き出す。空なら削除する。
    再実行を避けるため、record-changes.sh の重複排除（元表記の完全一致比較）を
    壊さないよう元表記のまま残す。"""
    if not keys:
        try: os.remove(path)
        except FileNotFoundError: pass
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for k in keys:
            fh.write(raw_by_key[k] + "\n")

def group_keys_by_root(keys):
    """(root, rel) キー列を root ごとの rel リストにグルーピングする（root の初出順を保つ）。"""
    order, rels_by_root = [], {}
    for root, rel in keys:
        if root not in rels_by_root:
            rels_by_root[root] = []
            order.append(root)
        rels_by_root[root].append(rel)
    return order, rels_by_root

def load_root_cfg(root, main_cfg):
    """root 自身の .claude/gate.yaml を読む。無ければメインの cfg にフォールバックする。"""
    path = os.path.join(root, ".claude", "gate.yaml")
    return load_action(path) if os.path.exists(path) else main_cfg

# ---- rules フェーズ ----
UNMATCHED_SHOWN = 5   # どのルールにもマッチしなかったファイルを 1 行に列挙する最大数

def note_unmatched_files(rels, triggered):
    """どのルールにもマッチせず何も実行されなかったファイルを、スキップとして 1 行で残す。"""
    covered = set()
    for _rule, matched, _pairs in triggered:
        covered |= set(matched)
    unmatched = sorted(set(rels) - covered)
    if not unmatched:
        return
    shown = ", ".join(unmatched[:UNMATCHED_SHOWN])
    more = f" ほか{len(unmatched) - UNMATCHED_SHOWN}件" if len(unmatched) > UNMATCHED_SHOWN else ""
    STATUS.append(f"[gate] skip: {shown}{more} (どのルールにもマッチしません)")

def run_rules(cfg, rels, logs, root_dir, policy_state=None):
    """rels に対してマッチしたルールの run だけを実行する。consistency_checks には
    一切触れない（実行するのは checks フェーズの責務）。root_dir は rule の dir /
    per_file_dir の結合先。policy_state を渡すと、policy が設定されたルールの run は
    ポリシー判定を通してから実行される。
    戻り値: (summary, failed, success_files, fail_files, check_names, check_ref_files)。
    check_names はマッチしたルールが run_checks で参照した名前（出現順・重複排除）、
    check_ref_files はその名前ごとの参照元マッチファイル集合（checks フェーズへの
    予約と、rules フェーズでの SIDECAR 退避判定の両方に使う）。"""
    rules = (cfg or {}).get("rules") or []

    triggered = []
    for rule in rules:
        pats = rule.get("match")
        pats = [pats] if isinstance(pats, str) else (pats or [])
        pattern_pairs = match_patterns(pats)
        matched = sorted({rp for rp in rels for _, rx in pattern_pairs if rx.match(rp)})
        if matched:
            triggered.append((rule, matched, pattern_pairs))

    summary, failed = [], False
    success_files, fail_files = set(), set()
    check_names, check_ref_files = [], {}
    for rule, matched, pattern_pairs in triggered:
        cmds = rule.get("run") or []
        timeout = rule.get("timeout") or DEFAULT_TIMEOUT
        policy = make_policy_context(cfg, rule, root_dir, policy_state, logs)
        rule_files = set(matched)
        for name in (rule.get("run_checks") or []):
            check_ref_files.setdefault(name, set()).update(rule_files)
            if name not in check_names:
                check_names.append(name)
        raw_per_file_dir = rule.get("per_file_dir")
        if raw_per_file_dir:
            mode = normalize_per_file_dir_mode(raw_per_file_dir)
            if mode is None:
                logs.append(
                    f"=== [gate] per_file_dir の値が不正です: {raw_per_file_dir!r}"
                    '（true / "file" / "pattern_root" のいずれかを指定してください）。'
                    "このルールをスキップします。 ==="
                )
                summary.append(summarize_cmds(cmds) + "  [skip: per_file_dir不正]")
                failed = True
                fail_files |= rule_files
                continue
            # mode == "file": マッチした各ファイル自身のディレクトリ（dirname）をルートに、
            # mode == "pattern_root": マッチしたパターンの最初の ** 直前をルートにし、
            # いずれもルート単位で重複排除して実行（ルート名の昇順）
            roots_by_rel = compute_per_file_roots(mode, pattern_pairs, matched)
            for d in sorted(set(roots_by_rel.values())):
                cwd = os.path.join(root_dir, d) if d else root_dir
                label = d or "."
                dir_files = {rp for rp in matched if roots_by_rel[rp] == d}
                if not os.path.isdir(cwd):
                    logs.append(f"=== [gate] ({label}) cwd が存在しません: {cwd}。このルートをスキップします。 ===")
                    summary.append(f"({label}) " + summarize_cmds(cmds) + "  [skip: cwd無し]")
                    note("skip", label, summarize_cmds(cmds), "(cwd が存在しません)")
                    continue
                summary.append(f"({label}) " + summarize_cmds(cmds))
                if run_cmds(label, cmds, cwd, timeout, logs, policy, files_env(dir_files)):
                    failed = True
                    fail_files |= dir_files
                else:
                    success_files |= dir_files
        else:
            cwd = os.path.join(root_dir, rule["dir"]) if rule.get("dir") else root_dir
            label = rule.get("dir", ".")
            if not os.path.isdir(cwd):
                logs.append(f"=== [gate] ({label}) cwd が存在しません: {cwd}。このルールをスキップします。 ===")
                summary.append(f"({label}) " + summarize_cmds(cmds) + "  [skip: cwd無し]")
                note("skip", label, summarize_cmds(cmds), "(cwd が存在しません)")
                continue
            summary.append(f"({label}) " + summarize_cmds(cmds))
            if run_cmds(label, cmds, cwd, timeout, logs, policy, files_env(rule_files)):
                failed = True
                fail_files |= rule_files
            else:
                success_files |= rule_files

    note_unmatched_files(rels, triggered)
    return summary, failed, success_files, fail_files, check_names, check_ref_files

def run_rules_all_roots(root_order, rels_by_root, main_cfg, logs, policy_state=None):
    """root ごとに run_rules を実行し、結果をキー (root, rel) 単位にまとめて返す。
    戻り値: (summary, failed, success_keys, fail_keys, consumed_keys,
    check_names_by_root, check_ref_keys_by_root)。後2つは checks フェーズへの
    予約に使う（check_ref_keys_by_root の値は consistency_check名 -> (root, rel) キー集合）。
    consumed_keys は worktree が既に消えていて対象から外した（消化済み扱いの）分。"""
    summary, failed = [], False
    success_keys, fail_keys, consumed_keys = set(), set(), set()
    check_names_by_root, check_ref_keys_by_root = {}, {}
    for root in root_order:
        rels = rels_by_root.get(root) or []
        if not rels:
            continue
        if root != PROJECT_DIR and not os.path.isdir(root):
            logs.append(f"=== [gate] worktree が見つかりません: {root}。対象から外します。 ===")
            consumed_keys |= {(root, rp) for rp in rels}
            continue
        cfg = main_cfg if root == PROJECT_DIR else load_root_cfg(root, main_cfg)
        prefix = "" if root == PROJECT_DIR else f"[{os.path.relpath(root, PROJECT_DIR)}] "
        r_summary, r_failed, r_success, r_fail, r_check_names, r_check_ref = run_rules(
            cfg, rels, logs, root_dir=root, policy_state=policy_state)
        summary.extend(prefix + s for s in r_summary)
        if r_failed:
            failed = True
        success_keys |= {(root, rp) for rp in r_success}
        fail_keys |= {(root, rp) for rp in r_fail}
        if r_check_names:
            check_names_by_root[root] = r_check_names
            check_ref_keys_by_root[root] = {
                name: {(root, rp) for rp in files} for name, files in r_check_ref.items()
            }
    return summary, failed, success_keys, fail_keys, consumed_keys, check_names_by_root, check_ref_keys_by_root

def load_pending():
    if not os.path.exists(PENDING):
        return {}
    try:
        with open(PENDING) as fh:
            return json.load(fh) or {}
    except (OSError, ValueError):
        return {}

def save_pending(data):
    if not data:
        try: os.remove(PENDING)
        except FileNotFoundError: pass
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(PENDING, "w") as fh:
        json.dump(data, fh, ensure_ascii=False)

def merge_pending_checks(check_names_by_root, check_ref_keys_by_root, raw_by_key):
    """rules フェーズで新たに参照された consistency_checks の予約を、ルートごとに
    既存の予約とユニオンして永続化する（複数回の PostToolUse をまたいで蓄積される）。
    ref ファイルは raw 表記（SIDECAR/CHANGED と同じ表記）で保持する。"""
    if not check_names_by_root:
        return
    data = load_pending()
    for root, names in check_names_by_root.items():
        root_checks = data.setdefault(root, {})
        ref = check_ref_keys_by_root.get(root) or {}
        for name in names:
            raws = {raw_by_key[k] for k in ref.get(name, set())}
            root_checks[name] = sorted(set(root_checks.get(name) or []) | raws)
    save_pending(data)

def run_rules_phase():
    if not (os.path.exists(ACTION) and os.path.exists(CHANGED)):
        return 0
    order, raw_by_key = load_changed_flat(CHANGED)
    if not order:
        try: os.remove(CHANGED)
        except FileNotFoundError: pass
        return 0

    cfg = load_action(ACTION)
    if isinstance(cfg, _YamlUnavailable):
        try: os.remove(CHANGED)
        except FileNotFoundError: pass
        msg = "[gate] YAML パーサ（PyYAML または yq）が見つからないため、rules チェックをスキップしました。"
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
        return 0
    rules = (cfg or {}).get("rules") or []
    if not rules:
        try: os.remove(CHANGED)
        except FileNotFoundError: pass
        return 0

    logs = []
    policy_state = PolicyState()
    keys_before_this_run = deferred_keys()
    root_order, rels_by_root = group_keys_by_root(order)
    (summary, failed, success_keys, fail_keys, consumed_keys,
     check_names_by_root, check_ref_keys_by_root) = run_rules_all_roots(
        root_order, rels_by_root, cfg, logs, policy_state)

    # ポリシー判定を通って実際に実行されたコマンドがあった回にだけ控えを消化する。
    # 消化するのはこの回が始まる前から控えにあった分だけ。この回の中で新しく
    # 積まれた分（allow されて undefer_cmd された後に別ルールの評価で再度 deny されて
    # 積み直された分を含む）は次回以降に回す（間引きを1回分は効かせるため）。
    # 控えの失敗は failed には数えるが、元の match ファイル集合とは切れているので
    # success_keys / fail_keys には影響させない。
    if policy_state.executed:
        keys_to_drain = keys_before_this_run - policy_state.deferred_this_run
        deferred_summary, deferred_failed = run_deferred(
            take_deferred_matching(keys_to_drain), logs)
        summary.extend(deferred_summary)
        if deferred_failed:
            failed = True

    if check_names_by_root:
        merge_pending_checks(check_names_by_root, check_ref_keys_by_root, raw_by_key)

    # run_checks を参照したキーだけ checks フェーズの確認待ちとして SIDECAR へ退避する。
    # run_checks を持たないルールで通ったキーは、それ以上待つものが無いので
    # CHANGED からも SIDECAR からも完全に手を離す。
    checked_keys = set()
    for ref in check_ref_keys_by_root.values():
        for keys in ref.values():
            checked_keys |= keys

    remaining, seen = [], set()
    sidecar_add, seen_sidecar = [], set()
    for k in order:
        if k in consumed_keys:
            continue
        if k in success_keys and k not in fail_keys:
            if k in checked_keys and k not in seen_sidecar:
                seen_sidecar.add(k); sidecar_add.append(k)
            continue
        if k in seen: continue
        seen.add(k); remaining.append(k)
    write_changed_flat(CHANGED, remaining, raw_by_key)

    if sidecar_add:
        existing_order, existing_raw = load_changed_flat(SIDECAR)
        merged = list(dict.fromkeys(existing_order + sidecar_add))
        raw_lookup = dict(existing_raw); raw_lookup.update(raw_by_key)
        write_changed_flat(SIDECAR, merged, raw_lookup)

    if failed:
        sys.stderr.write("\n".join(STATUS + logs) + "\n")
        sys.stderr.write(
            "[gate] rules フェーズの検証に失敗しました（会話は止まりません）。"
            "上のエラーを見て修正してください。\n"
        )
        return 2
    if summary or STATUS:
        body = status_block("\n".join(f"✓ {s}" for s in summary))
        msg = "[gate] rules フェーズ成功:\n" + body
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
    return 0

# ---- checks フェーズ ----
def run_named_checks(checks_by_name, names, logs, root_dir, cfg=None, policy_state=None,
                     files_by_name=None):
    """予約された consistency_checks の名前だけを実行する。戻り値: (summary, failed)。
    定義が見つからない／cwd が無いものはスキップ扱い（失敗にはしない）。policy_state を
    渡すと、policy が設定されたチェックの run はポリシー判定を通してから実行される。
    files_by_name はチェック名ごとの予約元ファイル（raw 表記）で、CLAUDE_GATE_FILES として
    run へ渡す。"""
    summary, failed = [], False
    for name in sorted(names):
        check = checks_by_name.get(name)
        if not check:
            logs.append(f"=== [gate] consistency_checks に \"{name}\" が見つかりません。スキップします。 ===")
            summary.append(f"(check:{name}) 見つかりません、スキップ")
            STATUS.append(f"[gate] skip: check:{name} (consistency_checks に定義がありません)")
            continue
        cwd = os.path.join(root_dir, check["dir"]) if check.get("dir") else root_dir
        cmds = check.get("run") or []
        timeout = check.get("timeout") or DEFAULT_TIMEOUT
        if not os.path.isdir(cwd):
            logs.append(f"=== [gate] (check:{name}) cwd が存在しません: {cwd}。このチェックをスキップします。 ===")
            summary.append(f"(check:{name}) " + summarize_cmds(cmds) + "  [skip: cwd無し]")
            note("skip", f"check:{name}", summarize_cmds(cmds), "(cwd が存在しません)")
            continue
        summary.append(f"(check:{name}) " + summarize_cmds(cmds))
        policy = make_policy_context(cfg, check, root_dir, policy_state, logs)
        refs = (files_by_name or {}).get(name) or []
        env = files_env(split_root(raw)[1] for raw in refs)
        if run_cmds(f"check:{name}", cmds, cwd, timeout, logs, policy, env):
            failed = True
    return summary, failed

def _pending_ref_keys(pending):
    """pending（{root: {check名: [raw,...]}}）から参照されている全 (root, rel) キーを返す。
    raw から root を復元するのに split_root を使い、CHANGED/SIDECAR の読み書きと
    解釈を一致させる（root キー自体は起動元ルートの記録であり、raw の再解釈と
    食い違うことは無い前提）。"""
    keys = set()
    for checks in pending.values():
        for raws in checks.values():
            for raw in raws:
                keys.add(split_root(raw))
    return keys

def _pending_raw_by_key(pending):
    raw_by_key = {}
    for checks in pending.values():
        for raws in checks.values():
            for raw in raws:
                raw_by_key.setdefault(split_root(raw), raw)
    return raw_by_key

def confirm_pending(pending):
    """予約された consistency_checks が全て成功したとき、対応するキーを
    SIDECAR から確定除去する（もう待つものが無い）。"""
    keys = _pending_ref_keys(pending)
    if not keys:
        return
    order, raw_by_key = load_changed_flat(SIDECAR)
    write_changed_flat(SIDECAR, [k for k in order if k not in keys], raw_by_key)

def requeue_pending_to_changed(pending):
    """consistency_checks の確認を諦めた（失敗し続けた、または YAML が読めない）とき、
    対応するキーを SIDECAR から取り除き CHANGED へ戻す。黙って確認済み扱いにはせず、
    次の編集で rules フェーズが再び拾えるようにする。"""
    keys = _pending_ref_keys(pending)
    if not keys:
        return
    sidecar_order, sidecar_raw = load_changed_flat(SIDECAR)
    write_changed_flat(SIDECAR, [k for k in sidecar_order if k not in keys], sidecar_raw)

    changed_order, changed_raw = load_changed_flat(CHANGED)
    raw_lookup = dict(_pending_raw_by_key(pending))
    raw_lookup.update(sidecar_raw); raw_lookup.update(changed_raw)
    merged = list(dict.fromkeys(changed_order + sorted(keys - set(changed_order))))
    write_changed_flat(CHANGED, merged, raw_lookup)

def purge_roots_from_sidecar(dropped_roots):
    """worktree が既に消えているルート分の予約は、SIDECAR からも静かに落とす
    （commit 先が無いので CHANGED へ戻す保険は不要）。"""
    if not dropped_roots:
        return
    order, raw_by_key = load_changed_flat(SIDECAR)
    write_changed_flat(SIDECAR, [k for k in order if k[0] not in dropped_roots], raw_by_key)

def run_checks_phase():
    pending = load_pending() if os.path.exists(PENDING) else {}
    if not pending:
        try: os.remove(PENDING)
        except FileNotFoundError: pass
    # rules フェーズの控えは、そこで実行が起きた回にしか消化されない。編集が止まると残り続け、
    # 未検証のまま commit / 終了してしまうので、checks フェーズでも全件消化する。
    deferred = take_deferred()
    if not pending and not deferred:
        return 0

    main_cfg = load_action(ACTION)
    if isinstance(main_cfg, _YamlUnavailable):
        requeue_deferred(deferred)
        requeue_pending_to_changed(pending)
        cleanup(only=(COUNT, PENDING))
        msg = "[gate] YAML パーサ（PyYAML または yq）が見つからないため、consistency checks をスキップしました。"
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
        return 0

    logs, summary, failed = [], [], False
    policy_state = PolicyState()
    active_pending, dropped_roots = {}, set()
    for root, checks_map in pending.items():
        if root != PROJECT_DIR and not os.path.isdir(root):
            logs.append(f"=== [gate] worktree が見つかりません: {root}。対象から外します。 ===")
            dropped_roots.add(root)
            continue
        active_pending[root] = checks_map
        cfg = main_cfg if root == PROJECT_DIR else load_root_cfg(root, main_cfg)
        checks_by_name = {c["name"]: c for c in (cfg or {}).get("consistency_checks") or []}
        prefix = "" if root == PROJECT_DIR else f"[{os.path.relpath(root, PROJECT_DIR)}] "
        r_summary, r_failed = run_named_checks(
            checks_by_name, checks_map.keys(), logs, root, cfg, policy_state, checks_map)
        summary.extend(prefix + s for s in r_summary)
        if r_failed:
            failed = True

    purge_roots_from_sidecar(dropped_roots)

    d_summary, d_failed = run_deferred(deferred, logs)
    summary.extend(d_summary)
    if d_failed:
        requeue_deferred(d_failed)
        failed = True

    if not failed:
        confirm_pending(active_pending)
        cleanup(only=(COUNT, PENDING))
        body = status_block("\n".join(f"✓ {s}" for s in summary) if summary else "（対象なし）")
        title = "consistency checks" if pending else "後回しにした検証コマンド"
        msg = f"[gate] {title} 成功:\n" + body
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
        return 0

    sys.stderr.write("\n".join(STATUS + logs) + "\n")

    attempts = 0
    try: attempts = int(open(COUNT).read().strip())
    except Exception: attempts = 0
    if not STOP_HOOK_ACTIVE:
        # 前回の Stop hook がブロックして継続させた結果の Stop ではない
        # = 新しいユーザーターン起点の Stop なので、リトライ回数を数え直す。
        attempts = 0
    attempts += 1
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(COUNT, "w") as fh: fh.write(str(attempts))

    if attempts >= MAX_ATTEMPTS:
        requeue_pending_to_changed(active_pending)
        cleanup(only=(COUNT, PENDING))
        sys.stderr.write(f"consistency checks が {MAX_ATTEMPTS} 回連続失敗。ループを打ち切ります。手動確認を。\n")
        msg = (f"[gate] consistency checks が{MAX_ATTEMPTS}回連続で失敗したため打ち切りました。"
               "対象ファイルは未検証のまま CHANGED へ戻しました。"
               "手動で確認してください。今すぐ解除したい場合は新しいセッションを開始するか "
               "/clear を実行してください（reset-gate.sh が状態ファイルを削除します）。\n"
               + "\n".join(f"✗ {s}" for s in summary)
               + with_details(""))
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
        return 0

    reason = (f"consistency checks 失敗（試行 {attempts}/{MAX_ATTEMPTS}）。上のエラーを見て修正を継続してください。\n"
              + "\n".join(f"✗ {s}" for s in summary)
              + with_details(""))
    sys.stderr.write(reason + "\n")
    # stdout が空だと harness 側の判定で exit 2 が non-blocking 扱いになる不具合があるため、
    # stderr の内容に関わらず必ず JSON を出す。
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    return 2

def main():
    prune_logs()
    if not os.path.exists(ACTION) and os.path.exists(GATE_YML):
        msg = ("[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。"
               "拡張子が yaml ではなく yml になっていないか確認してください。")
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
    if not os.path.exists(ACTION):
        cleanup(); return 0

    if PHASE == "rules":
        return run_rules_phase()
    return run_checks_phase()

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        msg = "[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。"
        print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
        sys.exit(0)
