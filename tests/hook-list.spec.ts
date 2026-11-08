import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Rule } from '../src/feedback-rules.ts'
import { describeFeedback, describeGate, hookListCommand, parseHookListArgs } from '../src/hook-list.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const NOW = Date.parse('2026-10-09T00:00:00.000Z')

const rule = (name: string, count: number, over: Partial<Rule> = {}): Rule => ({
  name,
  description: `desc ${name}`,
  count,
  enforce: [],
  path: `/home/u/.claude/feedback/${name}.md`,
  projects: [],
  whenExists: [],
  files: [],
  excludeFiles: [],
  ...over,
})

describe('parseHookListArgs', () => {
  test('defaults to both sections', () => {
    expect(parseHookListArgs('')).toEqual({ gate: true, feedback: true })
    expect(parseHookListArgs('foo')).toEqual({ gate: true, feedback: true })
  })
  test('gate / feedback pick one section', () => {
    expect(parseHookListArgs('gate')).toEqual({ gate: true, feedback: false })
    expect(parseHookListArgs(' feedback ')).toEqual({ gate: false, feedback: true })
  })
})

describe('describeGate', () => {
  test('without gate.yaml', () => {
    expect(describeGate(undefined, undefined, 'en')).toEqual([
      '■ gate.yaml',
      '  No gate.yaml (put one at .claude/gate.yaml or .agents/gate.yaml to turn the quality gate on).',
    ])
  })

  test('unreadable gate.yaml', () => {
    expect(describeGate(undefined, '/p/.claude/gate.yaml', 'en', 'bad indent')).toEqual([
      '■ gate.yaml',
      '  /p/.claude/gate.yaml',
      '  Not readable as YAML, so the gate does nothing: bad indent',
    ])
  })

  test('lists each phase with its timing and commands', () => {
    const cfg = {
      max_parallel: 3,
      rules: [
        {
          match: 'src/**/*.ts',
          per_file_dir: 'pattern_root',
          timeout: 120,
          run: [
            'bun run lint',
            {
              parallel: [
                { name: 'tc', cmd: 'tsc' },
                { cmd: 'bun test', share: false, files: false, timeout: 60 },
              ],
            },
          ],
          run_checks: ['build'],
        },
      ],
      consistency_checks: [
        { name: 'build', run: ['make build'] },
        { name: 'orphan', dir: 'pkg', run: ['make x'] },
      ],
      session_start: ['echo hi', { name: 'graph', cmd: 'graph summary', on: ['startup', 'clear'], background: true }],
    }
    const text = describeGate(cfg, '/p/.claude/gate.yaml', 'en').join('\n')
    expect(text).toContain('  rules (1)\n  When: right after a file is edited')
    expect(text).toContain(
      [
        '  1. match: src/**/*.ts',
        '    per_file_dir: pattern_root / timeout: 120s',
        '    run:',
        '      - `bun run lint`',
        '      in parallel:',
        '        - tc: `tsc`',
        '        - `bun test` (timeout 60s, share: false, files: false)',
        '    run_checks: build (reserved for the consistency_checks at stop when the rule matches)',
      ].join('\n'),
    )
    expect(text).toContain('  consistency_checks (2)\n  When: at stop (Stop / SubagentStop).')
    expect(text).toContain('  - build\n    run:\n      - `make build`')
    expect(text).toContain("  - orphan (not in any rule's run_checks, so it never runs)\n    dir: pkg\n")
    expect(text).toContain('  session_start (2)\n  When: at session start')
    expect(text).toContain('  - `echo hi`\n  - graph: `graph summary` (on: startup, clear, background)')
    expect(text.endsWith('  max_parallel: 3')).toBe(true)
  })

  test('empty phases say none', () => {
    const text = describeGate({ rules: [] }, '/p/.claude/gate.yaml', 'ja').join('\n')
    expect(text).toContain('rules（0 件）')
    expect(text.match(/（なし）/g)?.length).toBe(3)
  })
})

describe('describeFeedback', () => {
  const opts = { lang: 'en' as const, now: NOW, projectDirs: ['/p/.claude/feedback', '/p/.agents/feedback'] }

  test('active rules with injection, level and enforce details', () => {
    const rules = [
      rule('no_force_push', 5, {
        enforce: [{ event: 'pre_bash', when: 'git push.*--force', unless: '--force-with-lease', message: 'do not\nforce push' }],
      }),
      rule('go_errors', 3, {
        path: '/p/.claude/feedback/go_errors.md',
        files: ['**/*.go'],
        excludeFiles: ['**/*_test.go'],
        enforce: [
          { event: 'post_edit', path: ['**/*.go'], exclude_path: ['**/*_test.go'], when: 'return err$' },
          { event: 'stop_check', changed: '**/*.go', check: 'gofmt -l $FILE', severity: 'warn' },
        ],
      }),
      rule('draft', 1),
    ]
    expect(describeFeedback(rules, [], [], opts)).toEqual([
      '■ feedback rules (3 active / 0 inactive / 0 unreadable)',
      '  - no_force_push [global] count 5 (deny: injected, enforce denies / blocks)',
      '    desc no_force_push',
      '    Injected: on every prompt (UserPromptSubmit)',
      '    enforce:',
      '      - pre_bash [deny] checks the command before Bash runs',
      '        when: `git push.*--force`',
      '        unless: `--force-with-lease`',
      '        message: do not force push',
      '    /home/u/.claude/feedback/no_force_push.md',
      '  - go_errors [project] count 3 (confirmed: injected, enforce asks / blocks)',
      '    desc go_errors',
      '    Injected: when a file matching **/*.go is read or edited (except **/*_test.go)',
      '    enforce:',
      '      - post_edit [block] checks the whole file after an edit',
      '        path: **/*.go',
      '        exclude_path: **/*_test.go',
      '        when: `return err$`',
      '      - stop_check [warn] checks the files changed in the session at stop',
      '        changed: **/*.go',
      '        check: `gofmt -l $FILE`',
      '    /p/.claude/feedback/go_errors.md',
      '  - draft [global] count 1 (provisional: not injected, enforce warns)',
      '    desc draft',
      '    Injected: never (count < 3)',
      '    enforce: none (the hooks do not detect it)',
      '    /home/u/.claude/feedback/draft.md',
    ])
  })

  test('inactive and broken rules', () => {
    const inactive = [rule('old', 3, { expires: Date.parse('2026-01-01T23:59:59Z') }), rule('elsewhere', 3, { projects: ['~/x/**'] })]
    const broken = [{ path: '/p/.claude/feedback/bad.md', reason: 'frontmatter is not valid YAML' }]
    expect(describeFeedback([], inactive, broken, { ...opts, lang: 'ja' })).toEqual([
      '■ feedback ルール（有効 0 件 / 無効 2 件 / 読めない 1 件）',
      '  （なし）',
      '',
      '  無効なルール:',
      '  - old: expires（2026-01-01）を過ぎている',
      '    /home/u/.claude/feedback/old.md',
      '  - elsewhere: projects がこのプロジェクトに一致せず無効',
      '    /home/u/.claude/feedback/elsewhere.md',
      '',
      '  読めないルール（/correct で直し方を提案）:',
      '  - /p/.claude/feedback/bad.md',
      '    frontmatter is not valid YAML',
    ])
  })
})

describe('hookListCommand', () => {
  const withProject = async (body: (proj: string, feedback: string) => Promise<void>) => {
    const proj = tmpDir()
    const feedback = tmpDir()
    try {
      await body(proj, feedback)
    } finally {
      rmTree(proj)
      rmTree(feedback)
    }
  }
  const writeRule = (dir: string, name: string, extra = '') => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\ntype: feedback\ncount: 3\n${extra}---\n\nbody\n`)
  }

  test('reads gate.yaml and the global + project feedback rules', () =>
    withProject(async (proj, feedback) => {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(proj, '.claude', 'gate.yaml'), 'rules:\n  - match: "**/*.py"\n    run: [ruff check]\n')
      writeRule(feedback, 'global_rule', "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n")
      writeRule(path.join(proj, '.claude', 'feedback'), 'project_rule')
      const io = makeIo({ projectDir: proj, lang: 'en', env: { CLAUDE_FEEDBACK_DIR: feedback } })
      const r = await hookListCommand(io, '', { agentLaunchGuard: true })
      expect(r.context).toEqual([])
      expect(r.text.startsWith(`[hook-list] ${proj}\n\n■ gate.yaml\n  ${path.join(proj, '.claude', 'gate.yaml')}`)).toBe(true)
      expect(r.text).toContain('  1. match: **/*.py\n    run:\n      - `ruff check`')
      expect(r.text).toContain('■ feedback rules (2 active / 0 inactive / 0 unreadable)')
      expect(r.text).toContain('  - global_rule [global] count 3')
      expect(r.text).toContain('      - pre_bash [ask] checks the command before Bash runs\n        when: `rm -rf`')
      expect(r.text).toContain('  - project_rule [project] count 3')
      expect(r.text).toContain('  agentLaunchGuard: on')
      expect(r.text).toContain('  autoCount: on')
    }))

  test('gate only, unreadable yaml', () =>
    withProject(async (proj, feedback) => {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(proj, '.claude', 'gate.yaml'), 'rules: [\n')
      writeRule(feedback, 'global_rule')
      const r = await hookListCommand(makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: feedback } }), 'gate')
      expect(r.text).toContain('YAML として読めないため、ゲートは動きません: ')
      expect(r.text).not.toContain('feedback ルール')
      expect(r.text).not.toContain('プラグイン設定')
    }))

  test('feedback only, without gate.yaml', () =>
    withProject(async (proj, feedback) => {
      const r = await hookListCommand(makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: feedback } }), 'feedback')
      expect(r.text).toBe(`[hook-list] ${proj}\n\n■ feedback ルール（有効 0 件 / 無効 0 件 / 読めない 0 件）\n  （なし）`)
    }))
})
