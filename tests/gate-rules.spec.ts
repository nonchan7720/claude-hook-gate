import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { computePerFileRoots, fileRoot, globMatchRoot, normalizePerFileDirMode, summarizeCmds } from '../src/gate.ts'
import { matchPatterns } from '../src/glob.ts'
import type { Dict } from '../src/pyutil.ts'
import { recordChanges } from '../src/record-changes.ts'
import { stopTestGate } from '../src/stop-test-gate.ts'
import {
  changedPath,
  exists,
  gate,
  lines,
  read,
  checks as runChecks,
  rules as runRules,
  touch,
  writeChangedFiles,
  writeFakeDogwood,
  writeGateYaml,
} from './helpers/gate.ts'
import { MISSING_DOGWOOD_BIN, makeIo, withTmp } from './helpers/node-io.ts'

const mkdirs = (...parts: string[]) => fs.mkdirSync(path.join(...parts), { recursive: true })

describe('per_file_dir: file root (pure)', () => {
  test('root is dirname of the matched file', () => {
    for (const [rel, expected] of [
      ['packages/foo/x.go', 'packages/foo'],
      ['services/foo/src/utils/helper.py', 'services/foo/src/utils'],
      ['pkg/services/chat/x.go', 'pkg/services/chat'],
    ] as const) {
      expect(fileRoot(rel)).toBe(expected)
    }
  })
  test('file directly under project root gives empty root', () => {
    expect(fileRoot('x.py')).toBe('')
  })
})

describe('globMatchRoot (pattern_root)', () => {
  test('double star root stops before the ** segment', () => {
    for (const [pattern, rel, expected] of [
      ['packages/*/**/*.go', 'packages/foo/x.go', 'packages/foo'],
      ['services/*/**/*.py', 'services/foo/src/utils/helper.py', 'services/foo'],
      ['packages/api/**/*.go', 'packages/api/internal/x.go', 'packages/api'],
    ] as const) {
      expect(globMatchRoot(pattern, rel)).toBe(expected)
    }
  })
  test('pattern without ** falls back to dirname', () => {
    expect(globMatchRoot('services/*/*.py', 'services/foo/x.py')).toBe('services/foo')
  })
  test('leading ** gives project root', () => {
    expect(globMatchRoot('**/*.py', 'x.py')).toBe('')
  })
})

describe('normalizePerFileDirMode', () => {
  test('true and "file" normalize to file mode', () => {
    expect(normalizePerFileDirMode(true)).toBe('file')
    expect(normalizePerFileDirMode('file')).toBe('file')
  })
  test('"pattern_root" normalizes to pattern_root mode', () => {
    expect(normalizePerFileDirMode('pattern_root')).toBe('pattern_root')
  })
  test('invalid values return null', () => {
    for (const v of [false, null, '', 'bogus', 1, 'File', 'PATTERN_ROOT']) expect(normalizePerFileDirMode(v)).toBeNull()
  })
})

describe('computePerFileRoots', () => {
  test('file mode uses each file own dirname', () => {
    const pairs = matchPatterns(['pkg/**/*.go'])
    const roots = computePerFileRoots('file', pairs, ['pkg/services/chat/x.go', 'pkg/services/chat/y_test.go', 'pkg/domain/user/z.go'])
    expect(roots['pkg/services/chat/x.go']).toBe('pkg/services/chat')
    expect(roots['pkg/services/chat/y_test.go']).toBe('pkg/services/chat')
    expect(roots['pkg/domain/user/z.go']).toBe('pkg/domain/user')
  })
  test('pattern_root mode uses first matching pattern in match order', () => {
    expect(computePerFileRoots('pattern_root', matchPatterns(['packages/**/*.go', 'packages/api/**/*.go']), ['packages/api/x.go'])['packages/api/x.go']).toBe(
      'packages',
    )
    expect(computePerFileRoots('pattern_root', matchPatterns(['packages/api/**/*.go', 'packages/**/*.go']), ['packages/api/x.go'])['packages/api/x.go']).toBe(
      'packages/api',
    )
  })
  test('pattern_root mode dedupes by root across multiple files', () => {
    const roots = computePerFileRoots('pattern_root', matchPatterns(['services/*/**/*.py']), [
      'services/foo/a.py',
      'services/foo/sub/b.py',
      'services/bar/c.py',
    ])
    expect([...new Set(Object.values(roots))].sort()).toEqual(['services/bar', 'services/foo'])
  })
})

describe('summarizeCmds', () => {
  test('sequential commands are not joined with &&', () => {
    const r = summarizeCmds(['a', 'b', 'c'])
    expect(r).toBe('a ; b ; c')
    expect(r).not.toContain('&&')
  })
  test('parallel block still uses ampersand inside parens', () => {
    expect(summarizeCmds([{ cmd: 'echo a' }, { parallel: ['echo b', 'echo c'] }])).toBe('echo a ; (echo b & echo c)')
  })
})

describe('per_file_dir integration', () => {
  test('file mode cwd is matched file own directory', () =>
    withTmp(async (proj) => {
      const svc = path.join(proj, 'pkg', 'services', 'chat')
      touch(svc, 'marker.txt')
      touch(svc, 'x.go')
      writeGateYaml(proj, { rules: [{ match: 'pkg/**/*.go', per_file_dir: true, run: ['test -f marker.txt'] }] })
      writeChangedFiles(proj, 'sess1', 'pkg/services/chat/x.go')
      expect((await runRules(proj)).exitCode).toBe(0)
      // run_checks が無いので、成功したファイルは CHANGED から完全に消えている
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))

  test('file mode files in same directory share a single run', () =>
    withTmp(async (proj) => {
      const svc = path.join(proj, 'pkg', 'services', 'chat')
      touch(svc, 'x.go')
      touch(svc, 'y_test.go')
      const counter = path.join(proj, 'run_count.txt')
      writeGateYaml(proj, { rules: [{ match: 'pkg/**/*.go', per_file_dir: true, run: [`echo x >> ${counter}`] }] })
      writeChangedFiles(proj, 'sess1', 'pkg/services/chat/x.go', 'pkg/services/chat/y_test.go')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect(lines(counter).length).toBe(1)
    }))

  test('pattern_root mode cwd is service root, not leaf directory', () =>
    withTmp(async (proj) => {
      const svc = path.join(proj, 'services', 'foo')
      touch(svc, 'pyproject.toml')
      touch(svc, 'src', 'utils', 'helper.py')
      writeGateYaml(proj, { rules: [{ match: 'services/*/**/*.py', per_file_dir: 'pattern_root', run: ['test -f pyproject.toml'] }] })
      writeChangedFiles(proj, 'sess1', 'services/foo/src/utils/helper.py')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))
})

describe('CLAUDE_GATE_FILES', () => {
  test('rule run receives matched files', () =>
    withTmp(async (proj) => {
      for (const name of ['b.rb', 'a.rb', 'ignored.txt']) touch(proj, 'app', name)
      const out = path.join(proj, 'files.txt')
      writeGateYaml(proj, { rules: [{ match: 'app/**/*.rb', run: [`printf "%s\\n" "$CLAUDE_GATE_FILES" > ${out}`] }] })
      writeChangedFiles(proj, 'sess1', 'app/b.rb', 'app/a.rb', 'app/ignored.txt', 'app/b.rb')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect(read(out).trim()).toBe('app/a.rb app/b.rb')
    }))

  test('per_file_dir run receives only that root files', () =>
    withTmp(async (proj) => {
      for (const d of ['chat', 'user']) touch(proj, 'pkg', d, 'x.go')
      const out = path.join(proj, 'files.txt')
      writeGateYaml(proj, { rules: [{ match: 'pkg/**/*.go', per_file_dir: true, run: [`printf "%s\\n" "$CLAUDE_GATE_FILES" >> ${out}`] }] })
      writeChangedFiles(proj, 'sess1', 'pkg/chat/x.go', 'pkg/user/x.go')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect(lines(out).sort()).toEqual(['pkg/chat/x.go', 'pkg/user/x.go'])
    }))

  test('eval set -- recovers paths with spaces', () =>
    withTmp(async (proj) => {
      touch(proj, 'app', 'a b.rb')
      const out = path.join(proj, 'files.txt')
      writeGateYaml(proj, { rules: [{ match: 'app/**/*.rb', run: [`eval "set -- $CLAUDE_GATE_FILES"; for f in "$@"; do echo "$f" >> ${out}; done`] }] })
      writeChangedFiles(proj, 'sess1', 'app/a b.rb')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect(lines(out)).toEqual(['app/a b.rb'])
    }))

  test('consistency check run receives reserving files', () =>
    withTmp(async (proj) => {
      const out = path.join(proj, 'files.txt')
      const { setupReservedCheckProject } = await import('./helpers/gate.ts')
      setupReservedCheckProject(proj, 'sess1', [`printf "%s\\n" "$CLAUDE_GATE_FILES" > ${out}`])
      expect((await runRules(proj)).exitCode).toBe(0)
      expect((await runChecks(proj, 'sess1', { stopHookActive: true })).exitCode).toBe(0)
      expect(read(out).trim()).toBe('x.py')
    }))
})

describe('invalid per_file_dir value', () => {
  test('fails the rule instead of silently ignoring', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', per_file_dir: 'bogus', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      // rules フェーズの失敗は会話をブロックしないが、exit 2 で stderr 通知される
      const r = await runRules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("'bogus'")
    }))
})

describe('missing cwd', () => {
  test('dir rule with missing directory is skipped, not crashed', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'ghost/**/*.py', dir: 'ghost', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'ghost/x.py')
      expect((await runRules(proj)).exitCode).toBe(0)
    }))

  test('per_file_dir with missing root is skipped, not crashed', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'ghost/*/**/*.py', per_file_dir: true, run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'ghost/foo/bar.py')
      expect((await runRules(proj)).exitCode).toBe(0)
    }))

  test('consistency check with missing dir is skipped, not crashed', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['ghost-check'] }],
        consistency_checks: [{ name: 'ghost-check', dir: 'ghost', run: ['echo hi'] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await runRules(proj)).exitCode).toBe(0)
      expect((await runChecks(proj)).exitCode).toBe(0)
    }))
})

describe('status lines', () => {
  const message = (r: { stdout: string }) => (JSON.parse(r.stdout) as { systemMessage: string }).systemMessage

  test('rules phase prints ok line with label, cmd and seconds', () =>
    withTmp(async (proj) => {
      mkdirs(proj, 'sub')
      writeGateYaml(proj, { rules: [{ match: '**/*.py', dir: 'sub', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(0)
      expect(message(r)).toMatch(/\[gate\] ok: sub \$ echo hi \(\d+\.\ds\)/)
    }))

  test('ok line is printed for each parallel command', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ parallel: ['echo aaa', { cmd: 'echo bbb', name: 'second' }] }] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const msg = message(await runRules(proj))
      expect(msg).toMatch(/\[gate\] ok: \. \$ echo aaa \(/)
      expect(msg).toMatch(/\[gate\] ok: \. \$ echo bbb \(/)
    }))

  test('multiline cmd is collapsed to one line', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo first\necho second'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const msg = message(await runRules(proj))
      const okLines = msg.split('\n').filter((l) => l.startsWith('[gate] ok:'))
      expect(okLines.length).toBe(1)
      expect(okLines[0]).toContain('echo first ...')
      expect(msg).not.toContain('echo second')
    }))

  test('file matching no rule is reported as skipped', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py', 'notes.txt')
      const msg = message(await runRules(proj))
      const skip = msg.split('\n').filter((l) => l.startsWith('[gate] skip:'))
      expect(skip.length).toBe(1)
      expect(skip[0]).toMatch(/notes\.txt.*どのルールにもマッチしません/)
      expect(skip[0]).not.toContain('x.py')
    }))

  test('only unmatched files still prints a skip line', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'notes.txt')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(0)
      expect(message(r)).toContain('[gate] skip:')
    }))

  test('missing cwd is reported as skipped', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', dir: 'ghost', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect(message(await runRules(proj))).toMatch(/\[gate\] skip: ghost \$ echo hi .*cwd/)
    }))

  test('policy skip is reported as skipped', () =>
    withTmp(async (proj) => {
      const [fake] = writeFakeDogwood(path.join(proj, 'bin'), { verdict: 'deny' })
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await runRules(proj, 'sess1', { dogwoodBin: fake })
      expect(message(r)).toMatch(/\[gate\] skip: \. \$ echo hi .*ポリシー/)
    }))

  test('failure keeps detail and adds fail and ok lines on stderr', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo passed-cmd', 'echo boom-detail; exit 1'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toMatch(/\[gate\] ok: \. \$ echo passed-cmd \(/)
      expect(r.stderr).toMatch(/\[gate\] fail: \. \$ echo boom-detail; exit 1 \(/)
      expect(r.stderr).toContain('boom-detail')
    }))

  test('checks phase prints ok line', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['echo r'], run_checks: ['all'] }],
        consistency_checks: [{ name: 'all', run: ['echo whole'] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      await runRules(proj)
      const r = await runChecks(proj, 'sess1', { stopHookActive: true })
      expect(r.exitCode).toBe(0)
      expect(message(r)).toMatch(/\[gate\] ok: check:all \$ echo whole \(\d+\.\ds\)/)
    }))

  test('files env reaches the command', () =>
    withTmp(async (proj) => {
      const out = path.join(proj, 'files.out')
      mkdirs(proj, 'packages', 'app')
      writeGateYaml(proj, { rules: [{ match: 'packages/app/**/*.ts', dir: 'packages/app', run: [`echo "$CLAUDE_GATE_FILES" > ${out}`] }] })
      writeChangedFiles(proj, 'sess1', 'packages/app/src/a.ts', 'packages/app/src/b.ts')
      await runRules(proj)
      expect(read(out).trim()).toBe('packages/app/src/a.ts packages/app/src/b.ts')
    }))
})

describe('internal error safety net', () => {
  test('unexpected exception is caught: exit 0 with system message', () =>
    withTmp(async (proj) => {
      // match が文字列/リストではない不正な設定 -> パターン展開時に TypeError を誘発する
      writeGateYaml(proj, { rules: [{ match: 123, run: ['echo hi'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('systemMessage')
      expect(r.stdout).toContain('内部エラー')
      expect(r.stderr).toContain('internal error')
    }))

  test('a gate.yaml that cannot be parsed is reported the same way', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(proj, '.claude', 'gate.yaml'), 'rules: [unclosed\n')
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('内部エラー')
      expect(r.stderr).toContain('YAMLParseError')
    }))
})

describe('gate.yml typo', () => {
  test('warns when only the yml extension is present', () =>
    withTmp(async (proj) => {
      touch(proj, '.claude', 'gate.yml')
      const r = await gate(proj, 'sess1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('systemMessage')
      expect(r.stdout).toContain('gate.yml')
    }))

  test('no warning when neither file is present', () =>
    withTmp(async (proj) => {
      const r = await gate(proj, 'sess1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe('')
    }))
})

describe('stop-test-gate entry point', () => {
  const run = (proj: string, payload: Dict, phase?: string) =>
    stopTestGate(makeIo({ projectDir: proj, env: { DOGWOOD_BIN: MISSING_DOGWOOD_BIN } }), phase, payload)

  test('warns on yml typo without crashing', () =>
    withTmp(async (proj) => {
      touch(proj, '.claude', 'gate.yml')
      const r = await run(proj, { session_id: 'sess1' })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('gate.yml')
    }))

  test('exits silently when neither gate file exists', () =>
    withTmp(async (proj) => {
      const r = await run(proj, { session_id: 'sess1' })
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe('')
    }))

  const envCheck = (expr: string) => `test ${expr}`

  test('first arg selects rules phase', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck('"$CLAUDE_GATE_PHASE" = rules')] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1' }, 'rules')).exitCode).toBe(0)
    }))

  test('no arg defaults to checks phase', () =>
    withTmp(async (proj) => {
      // checks フェーズは PENDING が無ければ何もせず、rule の run は一切実行されない。
      const marker = path.join(proj, 'ran.marker')
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [`touch ${marker}`] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1' })).exitCode).toBe(0)
      expect(exists(marker)).toBe(false)
    }))

  test('stop_hook_active true is threaded through to the command env', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck('"$CLAUDE_STOP_HOOK_ACTIVE" = true')] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1', stop_hook_active: true }, 'rules')).exitCode).toBe(0)
    }))

  test('stop_hook_active false is threaded through to the command env', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck('"$CLAUDE_STOP_HOOK_ACTIVE" = false')] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1' }, 'rules')).exitCode).toBe(0)
    }))

  test('agent_id is threaded through to the command env', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck('"$CLAUDE_AGENT_ID" = agent1')] }] })
      writeChangedFiles(proj, 'sess1--agent1', 'x.py')
      expect((await run(proj, { session_id: 'sess1', agent_id: 'agent1' }, 'rules')).exitCode).toBe(0)
    }))

  test('agent_id absent leaves the env var unset', () =>
    withTmp(async (proj) => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: シェルのパラメータ展開（テンプレートリテラルではない）
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck('-z "${CLAUDE_AGENT_ID+set}"')] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1' }, 'rules')).exitCode).toBe(0)
    }))

  test('CLAUDE_PROJECT_DIR and CLAUDE_SESSION_ID are passed to the command', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [envCheck(`"$CLAUDE_PROJECT_DIR" = ${proj} -a "$CLAUDE_SESSION_ID" = sess1`)] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await run(proj, { session_id: 'sess1' }, 'rules')).exitCode).toBe(0)
    }))
})

describe('record-changes', () => {
  const run = (proj: string, payload: Dict) => recordChanges(makeIo({ projectDir: proj }), payload)
  const memo = (proj: string, id: string) => path.join(proj, '.claude', '.gate-status', `changed_files.${id}.txt`)

  test('agent_id present uses suffixed memo', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [] })
      const r = await run(proj, { session_id: 'sess1', agent_id: 'agent1', tool_input: { file_path: 'x.py' } })
      expect(r.exitCode).toBe(0)
      expect(read(memo(proj, 'sess1--agent1')).trim()).toBe('x.py')
      expect(exists(memo(proj, 'sess1'))).toBe(false)
    }))

  test('agent_id absent uses plain memo', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [] })
      const r = await run(proj, { session_id: 'sess1', tool_input: { file_path: 'x.py' } })
      expect(r.exitCode).toBe(0)
      expect(read(memo(proj, 'sess1')).trim()).toBe('x.py')
    }))

  test('the same path is recorded once', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [] })
      for (const p of ['x.py', 'y.py', 'x.py']) await run(proj, { session_id: 'sess1', tool_input: { file_path: p } })
      expect(lines(memo(proj, 'sess1'))).toEqual(['x.py', 'y.py'])
    }))

  test('does nothing without gate.yaml (opt-in)', () =>
    withTmp(async (proj) => {
      await run(proj, { session_id: 'sess1', tool_input: { file_path: 'x.py' } })
      expect(exists(memo(proj, 'sess1'))).toBe(false)
    }))
})
