// 後続コマンド（src/followup.ts）: 定義の読み込み、きっかけでの指示、実行の見届け、失敗時の組み立て直し、Stop のブロック。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_S,
  followupAfterBash,
  followupAfterBashFailure,
  followupCollect,
  followupStopCheck,
  loadPendingEntries,
  MAX_STOP_BLOCKS,
  pendingPath,
  placeholders,
  resetFollowups,
  resolveArgs,
  runFiles,
  runRegExp,
  scanFollowups,
} from '../src/followup.ts'
import type { Lang } from '../src/i18n.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const T0 = 1_700_000_000_000

const PR_CHECKS = [
  '---',
  'name: pr_checks',
  'description: PR を作ったら CI を見届ける',
  "when: '^gh pr create\\b'",
  "unless: '--dry-run'",
  "run: 'gh pr checks {{pr}} --watch'",
  'args:',
  "  pr: 'gh pr create の出力にある PR の URL（.../pull/N）の N'",
  '---',
  '',
  '失敗したチェックがあれば、そのログも確認すること。',
  '',
].join('\n')

describe('followup', () => {
  let proj: string
  let fb: string
  let fu: string
  let now = T0

  beforeEach(() => {
    proj = tmpDir('followup-proj-')
    fb = tmpDir('followup-fb-')
    fu = tmpDir('followup-def-')
    now = T0
  })
  afterEach(() => {
    rmTree(proj)
    rmTree(fb)
    rmTree(fu)
  })

  const io = (lang: Lang = 'ja') => makeIo({ projectDir: proj, lang, now: () => now, env: { CLAUDE_FEEDBACK_DIR: fb, CLAUDE_FOLLOWUP_DIR: fu } })
  const write = (name: string, text: string, dir = fu) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), text, 'utf8')
  }
  const bash = (command: string, extra: Dict = {}): Dict => ({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tu1',
    cwd: proj,
    ...extra,
  })
  const context = (r: { stdout: string }): string => String((JSON.parse(r.stdout).hookSpecificOutput as Dict).additionalContext)
  const pending = (stateId = 'sess-1') => loadPendingEntries(io(), stateId)

  describe('definitions', () => {
    test('reads the frontmatter, the args and the body; name defaults to the file name', async () => {
      write('pr_checks', PR_CHECKS)
      write('unnamed', "---\nwhen: '^git push'\nrun: 'gh pr checks --watch'\nmax_attempts: 5\n---\n")
      const { followups, broken } = await scanFollowups(io())
      expect(broken).toEqual([])
      expect(followups.map((f) => f.name)).toEqual(['pr_checks', 'unnamed'])
      const [pr, unnamed] = followups
      expect(pr?.description).toBe('PR を作ったら CI を見届ける')
      expect(pr?.when).toBe('^gh pr create\\b')
      expect(pr?.unless).toBe('--dry-run')
      expect(pr?.run).toBe('gh pr checks {{pr}} --watch')
      expect(pr?.args).toEqual({ pr: { from: 'output', hint: 'gh pr create の出力にある PR の URL（.../pull/N）の N' } })
      expect(pr?.timeout).toBe(DEFAULT_TIMEOUT_S)
      expect(pr?.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS)
      expect(pr?.body).toBe('失敗したチェックがあれば、そのログも確認すること。')
      expect(unnamed?.args).toEqual({})
      expect(unnamed?.maxAttempts).toBe(5)
      expect(unnamed?.body).toBe('')
    })

    test('a project definition with the same name wins over the global one', async () => {
      write('pr_checks', PR_CHECKS)
      write('pr_checks', "---\nname: pr_checks\nwhen: '^gh pr create'\nrun: 'gh pr checks --watch'\n---\n", path.join(proj, '.claude', 'followup'))
      const { followups } = await scanFollowups(io())
      expect(followups.map((f) => [f.name, f.run])).toEqual([['pr_checks', 'gh pr checks --watch']])
    })

    test('broken definitions are skipped on their own and recorded', async () => {
      write('pr_checks', PR_CHECKS)
      write('no_run', "---\nwhen: '^x'\n---\n")
      write('bad_regex', "---\nwhen: 'a*+'\nrun: 'y'\n---\n")
      write('bad_arg', "---\nwhen: '^x'\nrun: 'y {{a}}'\nargs:\n  a:\n    pattern: '(?x)z'\n---\n")
      write('bad_yaml', '---\nwhen: [\n---\n')
      write('plain', 'no frontmatter\n')
      const { followups, broken } = await scanFollowups(io())
      expect(followups.map((f) => f.name)).toEqual(['pr_checks'])
      expect(broken.map((b) => path.basename(b.path)).sort()).toEqual(['bad_arg.md', 'bad_regex.md', 'bad_yaml.md', 'no_run.md'])
      expect(broken.find((b) => b.path.endsWith('bad_arg.md'))?.reason).toContain('args.a.pattern の正規表現が使えません')
      expect(broken.find((b) => b.path.endsWith('no_run.md'))?.reason).toBe('後続コマンドの定義を読めません: run がありません（必須）')
      expect(broken.find((b) => b.path.endsWith('bad_regex.md'))?.reason).toContain('when の正規表現が使えません')
      // 使われた時点で .errors.jsonl に残る
      await followupAfterBash(io(), bash('ls'))
      const errors = fs
        .readFileSync(path.join(fb, '.errors.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      expect(errors.map((e) => path.basename(e.file)).sort()).toEqual(['bad_arg.md', 'bad_regex.md', 'bad_yaml.md', 'no_run.md'])
      expect(errors.every((e) => e.source === 'followup')).toBe(true)
    })

    test('projects / when_exists / expires limit a definition like a feedback rule', async () => {
      write('a', `---\nwhen: '^a'\nrun: 'x'\nprojects: ['/no/such/**']\n---\n`)
      write('b', `---\nwhen: '^b'\nrun: 'x'\nwhen_exists: ['go.mod']\n---\n`)
      write('c', `---\nwhen: '^c'\nrun: 'x'\nexpires: 2000-01-01\n---\n`)
      write('d', `---\nwhen: '^d'\nrun: 'x'\nprojects: ['${proj}']\n---\n`)
      expect((await scanFollowups(io())).followups.map((f) => f.name)).toEqual(['d'])
      fs.writeFileSync(path.join(proj, 'go.mod'), '')
      expect((await scanFollowups(io())).followups.map((f) => f.name)).toEqual(['b', 'd'])
    })
  })

  describe('run template', () => {
    test('placeholders are listed once each, in order', () => {
      expect(placeholders('gh pr checks {{pr}} --repo {{ repo }} {{pr}}')).toEqual(['pr', 'repo'])
      expect(placeholders('gh pr checks --watch')).toEqual([])
    })

    test('the filled command matches the template; quoted values, extra whitespace and a suffix are fine', () => {
      const rx = runRegExp('gh pr checks {{pr}} --watch')
      expect(rx.test('gh pr checks 123 --watch')).toBe(true)
      expect(rx.test('gh  pr checks "123" --watch 2>&1')).toBe(true)
      expect(rx.test("cd /x && gh pr checks '12 3' --watch")).toBe(true)
      expect(rx.test('gh pr checks --watch')).toBe(false)
      expect(rx.test('gh pr view 123')).toBe(false)
      // 雛形の正規表現の特殊文字はそのままの文字
      expect(runRegExp('go test ./... -run {{name}}').test('go test ./... -run TestX')).toBe(true)
      expect(runRegExp('go test ./... -run {{name}}').test('go test ./abc -run TestX')).toBe(false)
    })
  })

  describe('PostToolUse(Bash)', () => {
    test('a matching command queues the follow-up and asks Claude to run it with the arguments filled', async () => {
      write('pr_checks', PR_CHECKS)
      const r = await followupAfterBash(io(), bash('gh pr create --title "x" --body "y"'))
      expect(r.exitCode).toBe(0)
      expect(context(r)).toBe(
        [
          '[followup] `gh pr create --title "x" --body "y"` を実行したので、続けて次の後続コマンドを実行してください（pr_checks: PR を作ったら CI を見届ける）:',
          '  gh pr checks {{pr}} --watch',
          '{{...}} の埋め方（直前のコマンドの出力などから推測して埋める）:',
          '  {{pr}}: gh pr create の出力にある PR の URL（.../pull/N）の N',
          '失敗したチェックがあれば、そのログも確認すること。',
          '次の Bash でこのコマンドを実行し（時間がかかるなら run_in_background: true で）、その結果をユーザーに報告してください。実行するまで終了（Stop）はブロックされます。',
        ].join('\n'),
      )
      const entries = await pending()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        name: 'pr_checks',
        run: 'gh pr checks {{pr}} --watch',
        mode: 'claude',
        trigger: 'gh pr create --title "x" --body "y"',
        attempts: 0,
        attempted: false,
        toolUseId: 'tu1',
      })
      // 状態はプロジェクトの作業ツリーではなく followup 側の置き場に書かれる
      expect(fs.existsSync(pendingPath(io(), 'sess-1'))).toBe(true)
      expect(fs.existsSync(path.join(proj, '.claude'))).toBe(false)
    })

    test('in English', async () => {
      write('pr_checks', PR_CHECKS)
      const r = await followupAfterBash(io('en'), bash('gh pr create'))
      expect(context(r)).toContain('[followup] `gh pr create` has run, so run the following follow-up command next (pr_checks: PR を作ったら CI を見届ける):')
      expect(context(r)).toContain('Run this command in your next Bash call (with run_in_background: true if it takes long) and report its result to the user.')
    })

    test('unless, non-matching commands and an empty command do nothing', async () => {
      write('pr_checks', PR_CHECKS)
      expect(await followupAfterBash(io(), bash('gh pr create --dry-run'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(await followupAfterBash(io(), bash('gh pr view'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(await followupAfterBash(io(), { session_id: 'sess-1', tool_name: 'Bash', tool_input: {} })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(await pending()).toEqual([])
    })

    test('a placeholder without a description gets a generic hint; a multi-line trigger command is folded to one line', async () => {
      write('x', "---\nwhen: '^make'\nrun: 'open {{report}}'\n---\n")
      const r = await followupAfterBash(io(), bash('make \\\n  report'))
      expect(context(r)).toContain('[followup] `make \\` を実行したので')
      expect(context(r)).toContain('  {{report}}: （説明なし。文脈から推測する）')
    })

    test('running the follow-up successfully clears it and reports completion', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      const r = await followupAfterBash(io(), bash('gh pr checks 42 --watch', { tool_use_id: 'tu2' }))
      expect(context(r)).toBe('[followup] 後続コマンド `gh pr checks 42 --watch`（pr_checks）が成功しました。その結果をユーザーへの報告に含めてください。')
      expect(await pending()).toEqual([])
      expect(fs.existsSync(pendingPath(io(), 'sess-1'))).toBe(false)
    })

    test('the follow-up does not re-trigger its own definition, but other definitions can chain', async () => {
      write('pr', "---\nname: pr\nwhen: '^gh pr\\b'\nrun: 'gh pr checks {{pr}} --watch'\n---\n")
      write('after_checks', "---\nname: after_checks\nwhen: '^gh pr checks'\nrun: 'gh pr merge {{pr}} --auto'\n---\n")
      await followupAfterBash(io(), bash('gh pr create'))
      expect((await pending()).map((p) => p.name)).toEqual(['pr'])
      const r = await followupAfterBash(io(), bash('gh pr checks 7 --watch'))
      expect(context(r)).toContain('（pr）が成功しました')
      expect(context(r)).toContain('gh pr merge {{pr}} --auto')
      expect((await pending()).map((p) => p.name)).toEqual(['after_checks'])
    })

    test('two triggers queue two entries, resolved one at a time', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create -B main'))
      await followupAfterBash(io(), bash('gh pr create -B release', { tool_use_id: 'tu2' }))
      expect((await pending()).map((p) => p.trigger)).toEqual(['gh pr create -B main', 'gh pr create -B release'])
      await followupAfterBash(io(), bash('gh pr checks 1 --watch'))
      expect((await pending()).map((p) => p.trigger)).toEqual(['gh pr create -B release'])
    })

    test('entries are kept per agent', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create', { agent_id: 'a1' }))
      expect(await pending()).toEqual([])
      expect((await pending('sess-1--a1')).map((p) => p.name)).toEqual(['pr_checks'])
      // 別のエージェントが同じコマンドを実行しても消えない
      await followupAfterBash(io(), bash('gh pr checks 1 --watch'))
      expect((await pending('sess-1--a1')).map((p) => p.name)).toEqual(['pr_checks'])
    })
  })

  describe('PostToolUseFailure(Bash)', () => {
    const failure = (command: string, extra: Dict = {}) =>
      bash(command, { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nno pull requests found for branch', ...extra })

    test('a failed follow-up counts an attempt and asks Claude to rebuild the command', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      const r = await followupAfterBashFailure(io(), failure('gh pr checks abc --watch'))
      expect(context(r)).toBe(
        '[followup] 後続コマンド `gh pr checks abc --watch`（pr_checks）が失敗しました（試行 1/3）。上のエラーを見て、コマンドや引数が誤っていれば正しいコマンドに組み立て直して再実行してください。コマンドは正しく、この失敗がそのまま結果（CI の失敗など）なら、再実行せずにその結果をユーザーに報告してください。',
      )
      expect(await pending()).toMatchObject([{ name: 'pr_checks', attempts: 1, attempted: true }])
      // 組み立て直して成功すれば消える
      const done = await followupAfterBash(io(), bash('gh pr checks 42 --watch'))
      expect(context(done)).toContain('が成功しました')
      expect(await pending()).toEqual([])
    })

    test('gives up after max_attempts failures', async () => {
      write('x', "---\nname: x\nwhen: '^a$'\nrun: 'b {{n}}'\nmax_attempts: 2\n---\n")
      await followupAfterBash(io(), bash('a'))
      const first = await followupAfterBashFailure(io(), failure('b 1'))
      expect(context(first)).toContain('（試行 1/2）')
      const second = await followupAfterBashFailure(io(), failure('b 2'))
      expect(context(second)).toBe('[followup] 後続コマンド（x）が 2 回失敗したので打ち切ります。失敗の内容をユーザーに報告してください。')
      expect(await pending()).toEqual([])
    })

    test('an interrupted follow-up is dropped silently; unrelated failures are ignored', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      expect(await followupAfterBashFailure(io(), failure('ls /nope'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(await pending()).toHaveLength(1)
      expect(await followupAfterBashFailure(io(), failure('gh pr checks 1 --watch', { is_interrupt: true }))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(await pending()).toEqual([])
    })
  })

  describe('Stop', () => {
    const stop = (extra: Dict = {}) => followupStopCheck(io(), { session_id: 'sess-1', stop_hook_active: false, ...extra })

    test('blocks while a follow-up has never been run, and passes once it ran (even if it failed)', async () => {
      write('pr_checks', PR_CHECKS)
      expect(await stop()).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      await followupAfterBash(io(), bash('gh pr create --fill'))
      const r = await stop()
      expect(r.exitCode).toBe(2)
      expect(JSON.parse(r.stdout).reason).toBe(
        [
          '[followup] まだ実行していない後続コマンドがあります。先に実行してから終了してください（試行 1/3）:',
          '- pr_checks: PR を作ったら CI を見届ける: `gh pr checks {{pr}} --watch`（きっかけ: `gh pr create --fill`）',
        ].join('\n'),
      )
      expect(r.stderr.trim()).toBe(JSON.parse(r.stdout).reason)
      await followupAfterBashFailure(io(), bash('gh pr checks x --watch', { error: 'Exit code 1' }))
      expect(await stop()).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      // 再試行待ちの保留は残る
      expect(await pending()).toMatchObject([{ attempted: true }])
    })

    test('gives up after MAX_STOP_BLOCKS blocks in a row and drops the never-run entries', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      let r = await stop()
      for (let i = 1; i < MAX_STOP_BLOCKS; i++) r = await stop({ stop_hook_active: true })
      expect(r.exitCode).toBe(0)
      expect(r.stderr.trim()).toBe('[followup] 後続コマンドが 3 回続けて実行されなかったので、要求を取り下げます。手動で確認してください。')
      expect(await pending()).toEqual([])
    })

    test('the block counter resets once the follow-up ran', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      await stop()
      await stop({ stop_hook_active: true })
      await followupAfterBash(io(), bash('gh pr checks 3 --watch'))
      expect(await stop({ stop_hook_active: true })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      await followupAfterBash(io(), bash('gh pr create -B v2'))
      expect(JSON.parse((await stop()).stdout).reason).toContain('（試行 1/3）')
    })

    test('a subagent only waits for its own follow-ups', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create', { agent_id: 'a1' }))
      expect((await stop()).exitCode).toBe(0)
      expect((await stop({ agent_id: 'a1' })).exitCode).toBe(2)
    })
  })

  describe('SessionStart', () => {
    test('startup / clear remove the session state; resume keeps it; old files are removed anyway', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      await followupAfterBash(io(), bash('gh pr create', { agent_id: 'a1' }))
      await followupAfterBash(io(), bash('gh pr create', { session_id: 'sess-2' }))
      await resetFollowups(io(), { session_id: 'sess-1', source: 'resume' })
      expect(fs.readdirSync(path.dirname(pendingPath(io(), 'x'))).sort()).toEqual(['sess-1--a1.json', 'sess-1.json', 'sess-2.json'])
      await resetFollowups(io(), { session_id: 'sess-1', source: 'startup' })
      expect(fs.readdirSync(path.dirname(pendingPath(io(), 'x')))).toEqual(['sess-2.json'])
      // 24 時間より古いファイル（mtime）は、他のセッションの resume でも消える
      const old = (T0 - 25 * 60 * 60 * 1000) / 1000
      fs.utimesSync(pendingPath(io(), 'sess-2'), old, old)
      await resetFollowups(io(), { session_id: 'other', source: 'resume' })
      expect(fs.readdirSync(path.dirname(pendingPath(io(), 'x')))).toEqual([])
    })

    test('stale entries inside a file are ignored when loading', async () => {
      write('pr_checks', PR_CHECKS)
      await followupAfterBash(io(), bash('gh pr create'))
      now = T0 + 25 * 60 * 60 * 1000
      expect(await pending()).toEqual([])
      expect((await followupStopCheck(io(), { session_id: 'sess-1' })).exitCode).toBe(0)
    })
  })

  describe('hook mode (arguments resolved by pattern, run in the background by the hook)', () => {
    const HOOK_RUN = [
      '---',
      'name: pr_checks',
      'description: PR を作ったら CI を見届ける',
      "when: '^gh pr create\\b'",
      "run: 'echo checks for {{pr}} in {{repo}}; echo err >&2'",
      'args:',
      '  pr:',
      "    pattern: 'pull/(\\d+)'",
      "    hint: 'PR 番号'",
      '  repo:',
      '    from: command',
      "    pattern: '--repo\\s+(\\S+)'",
      'timeout: 5',
      '---',
      '',
    ].join('\n')
    const created = (command = 'gh pr create --repo o/r', extra: Dict = {}) =>
      bash(command, { tool_response: { stdout: 'https://github.com/o/r/pull/12\n', stderr: '' }, ...extra })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const waitExit = async (runId: string) => {
      const f = runFiles(io(), runId).exit
      for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(50)
    }

    test('resolveArgs fills every placeholder from the output / command and shell-quotes the values', () => {
      const f = {
        run: 'gh pr checks {{pr}} --title {{t}}',
        args: { pr: { from: 'output' as const, pattern: 'pull/(\\d+)' }, t: { from: 'command' as const, pattern: '-t (.+)$' } },
      }
      const base = { name: 'x', description: '', when: '', timeout: 1, maxAttempts: 1, body: '', path: '', projects: [], whenExists: [] }
      expect(resolveArgs({ ...base, ...f }, 'gh pr create -t a b', 'see https://github.com/o/r/pull/7')).toEqual({
        command: "gh pr checks 7 --title 'a b'",
        values: { pr: '7', t: 'a b' },
      })
      expect(resolveArgs({ ...base, ...f }, 'gh pr create', 'no url')).toBeUndefined()
      // 説明だけの引数は hook では埋まらない
      expect(resolveArgs({ ...base, run: 'x {{a}}', args: { a: { from: 'output' as const, hint: 'h' } } }, '', '')).toBeUndefined()
      // 穴が無ければそのまま
      expect(resolveArgs({ ...base, run: 'gh pr checks --watch', args: {} }, '', '')).toEqual({ command: 'gh pr checks --watch', values: {} })
    })

    test('starts the command in the background, tells Claude, and hands the result over at the next hook', async () => {
      write('pr_checks', HOOK_RUN)
      const r = await followupAfterBash(io(), created())
      expect(context(r)).toBe(
        '[followup] `gh pr create --repo o/r` を実行したので、後続コマンド（pr_checks: PR を作ったら CI を見届ける）をバックグラウンドで開始しました: `echo checks for 12 in o/r; echo err >&2`。結果は終わり次第渡します（遅くとも終了（Stop）時に待ち合わせて渡します）。待たずに作業を続けてください。',
      )
      const [p] = await pending()
      expect(p).toMatchObject({ mode: 'hook', attempted: true, command: 'echo checks for 12 in o/r; echo err >&2', timeout: 5, cwd: proj })
      expect(p?.runId?.startsWith('sess-1.')).toBe(true)
      await waitExit(String(p?.runId))
      // Stop は止めず、結果を理由にして一度ブロックする
      const stop = await followupStopCheck(io(), { session_id: 'sess-1' })
      expect(stop.exitCode).toBe(2)
      const reason: string = JSON.parse(stop.stdout).reason
      expect(reason.split('\n')[0]).toMatch(
        /^\[followup\] 後続コマンド `echo checks for 12 in o\/r; echo err >&2`（pr_checks）が終了しました（exit 0、\d+s）。この結果をユーザーに報告してください（出力の全文: .*\.log）:$/,
      )
      expect(reason.split('\n').slice(1)).toEqual(['checks for 12 in o/r', 'err'])
      expect(await pending()).toEqual([])
      // ログは残り、終了コードと PID のファイルは片付く
      const files = runFiles(io(), String(p?.runId))
      expect(fs.existsSync(files.log)).toBe(true)
      expect(fs.existsSync(files.exit)).toBe(false)
      expect(fs.existsSync(files.pid)).toBe(false)
      expect((await followupStopCheck(io(), { session_id: 'sess-1' })).exitCode).toBe(0)
    })

    test('a finished run is handed over by any PostToolUse or by UserPromptSubmit, with a non-zero exit', async () => {
      write('x', "---\nwhen: '^a$'\nrun: 'echo nope; exit 3'\n---\n")
      await followupAfterBash(io(), bash('a'))
      const [p] = await pending()
      await waitExit(String(p?.runId))
      const r = await followupCollect(io(), { session_id: 'sess-1', tool_name: 'Read', tool_input: {} })
      expect(context(r)).toContain('（x）が終了しました（exit 3、')
      expect(context(r)).toContain('\nnope')
      expect(await pending()).toEqual([])
      // 2 回目は何も無い
      expect(await followupCollect(io(), { session_id: 'sess-1', tool_name: 'Read' })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      // UserPromptSubmit は素のテキストで返す
      await followupAfterBash(io(), bash('a'))
      await waitExit(String((await pending())[0]?.runId))
      const u = await followupCollect(io(), { session_id: 'sess-1' }, 'UserPromptSubmit')
      expect(u.stdout).toContain('（x）が終了しました（exit 3、')
    })

    test('Stop waits for a running command and then reports its result', async () => {
      write('x', "---\nwhen: '^a$'\nrun: 'sleep 1; echo late'\n---\n")
      await followupAfterBash(io(), bash('a'))
      // 終わる前の PostToolUse では渡さない
      expect(await followupCollect(io(), { session_id: 'sess-1', tool_name: 'Read' })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      const log: Array<string | undefined> = []
      const stop = await followupStopCheck(
        makeIo({ projectDir: proj, lang: 'ja', now: () => T0, env: { CLAUDE_FEEDBACK_DIR: fb, CLAUDE_FOLLOWUP_DIR: fu }, progressLog: log }),
        { session_id: 'sess-1' },
      )
      expect(stop.exitCode).toBe(2)
      expect(JSON.parse(stop.stdout).reason).toContain('\nlate')
      expect(log.some((l) => l?.startsWith('[followup] 待機中: sleep 1; echo late ('))).toBe(true)
      expect(await pending()).toEqual([])
    })

    test('Stop kills a command that exceeds its timeout and reports the output so far', async () => {
      write('x', "---\nwhen: '^a$'\nrun: 'echo begin; sleep 30; echo never'\ntimeout: 1\n---\n")
      // timeout の判定には実時間が要る
      const real = () => makeIo({ projectDir: proj, lang: 'ja', env: { CLAUDE_FEEDBACK_DIR: fb, CLAUDE_FOLLOWUP_DIR: fu } })
      await followupAfterBash(real(), bash('a'))
      const [p] = await loadPendingEntries(real(), 'sess-1')
      const pid = fs.readFileSync(runFiles(io(), String(p?.runId)).pid, 'utf8').trim()
      const stop = await followupStopCheck(real(), { session_id: 'sess-1' })
      expect(stop.exitCode).toBe(2)
      const reason: string = JSON.parse(stop.stdout).reason
      expect(reason).toContain('が 1 秒以内に終わらなかったので止めました')
      // 見出し（コマンド名を含む）の後ろは、止めるまでに出た出力だけ
      expect(reason.split('\n').slice(1)).toEqual(['begin'])
      expect(await loadPendingEntries(real(), 'sess-1')).toEqual([])
      await sleep(200)
      // 止めた後は runner のシェルもその子（sleep）も残らない。PID 1 が回収しない環境ではゾンビ（Z）が残るので、それは消えたとみなす。
      const alive = (p: number): boolean => {
        if (fs.existsSync('/proc')) return fs.existsSync(`/proc/${p}`) && !fs.readFileSync(`/proc/${p}/stat`, 'utf8').includes(') Z')
        try {
          process.kill(p, 0)
          return true
        } catch {
          return false
        }
      }
      expect(alive(Number(pid))).toBe(false)
      const children = execFileSync('ps', ['-eo', 'pgid=,pid='])
        .toString()
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter(([pgid, p]) => pgid === pid && alive(Number(p)))
      expect(children).toEqual([])
    })

    test('falls back to asking Claude when a placeholder cannot be resolved', async () => {
      write('pr_checks', HOOK_RUN)
      const r = await followupAfterBash(io(), created('gh pr create', { tool_response: { stdout: 'no url here' } }))
      expect(context(r)).toContain('続けて次の後続コマンドを実行してください')
      expect(context(r)).toContain('  {{pr}}: PR 番号')
      expect(context(r)).toContain('  {{repo}}: （説明なし。文脈から推測する）')
      expect(await pending()).toMatchObject([{ mode: 'claude', attempted: false }])
    })

    test('reset removes the run files of the session', async () => {
      write('x', "---\nwhen: '^a$'\nrun: 'echo hi'\n---\n")
      await followupAfterBash(io(), bash('a'))
      await followupAfterBash(io(), bash('a', { session_id: 'sess-2' }))
      await waitExit(String((await pending())[0]?.runId))
      await waitExit(String((await pending('sess-2'))[0]?.runId))
      await resetFollowups(io(), { session_id: 'sess-1', source: 'startup' })
      const left = fs.readdirSync(path.dirname(runFiles(io(), 'x').log))
      expect(left.every((n) => n.startsWith('sess-2.'))).toBe(true)
      expect(left.length).toBe(3)
    })
  })
})
