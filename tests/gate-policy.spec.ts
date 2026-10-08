import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cedarString, PolicyState, slug, traceLine } from '../src/gate.ts'
import {
  checks,
  deferredPath,
  exists,
  type FakeDogwoodOpts,
  newGate,
  read,
  readCalls,
  readDeferred,
  readTraceRecords,
  rules,
  tracePath,
  writeChangedFiles,
  writeDeferred,
  writeFakeDogwood,
  writeGateYaml,
  writePolicy,
  writeTraceRecords,
} from './helpers/gate.ts'
import { withTmp } from './helpers/node-io.ts'

const ok = (r: { exitCode: number; stderr?: string }) => expect(r.exitCode, r.stderr).toBe(0)
const names = (proj: string) => readTraceRecords(proj, 'sess1').map((r) => r.name)
const kinds = (proj: string) => readTraceRecords(proj, 'sess1').map((r) => r.kind)

describe('resolveDogwood', () => {
  test('DOGWOOD_BIN is used as is', () =>
    withTmp(async (proj) => {
      const [fake] = writeFakeDogwood(path.join(proj, 'bin'))
      expect(await newGate(proj, 'sess1', { dogwoodBin: fake }).resolveDogwood()).toBe(fake)
    }))

  test('a missing DOGWOOD_BIN does not fall back to PATH', () =>
    withTmp(async (proj) => {
      expect(await newGate(proj, 'sess1', { dogwoodBin: path.join(proj, 'nope') }).resolveDogwood()).toBeUndefined()
    }))
})

describe('cedar trace lines', () => {
  test('quotes and backslashes are escaped', () => {
    expect(cedarString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })

  test('control characters are escaped', () => {
    expect(cedarString('a\nb\r\tc"\\')).toBe('"a\\nb\\r\\tc\\"\\\\"')
  })

  test('multiline cmd is a single line', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: シェルのパラメータ展開を含むコマンド文字列（テンプレートリテラルではない）
    const line = traceLine({ ts: 1, name: 'all-type-check', kind: 'response', cmd: 'for pkg in packages/*/; do\n  echo "${pkg}"\ndone\nexit $status' }, '/p', 0)
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
  })

  test('request line carries ts, project, name and cmd', () => {
    const line = traceLine({ ts: 1000, name: 'hooks-pytest', cmd: 'pytest tests -q', kind: 'request' }, 'claude', 0)
    expect(line.startsWith('@1000 ')).toBe(true)
    expect(line).toContain('Gate::Agent::"gate"')
    expect(line).toContain('Gate::Project::"claude"')
    expect(line).toContain('Gate::Action::"Run"::request(')
    expect(line).toContain('name: "hooks-pytest"')
    expect(line).toContain('cmd: "pytest tests -q"')
  })

  test('history kinds use their own event name', () => {
    for (const kind of ['response', 'error']) expect(traceLine({ ts: 1, name: 'n', cmd: 'c', kind }, 'p', 1)).toContain(`Gate::Action::"Run"::${kind}(`)
  })
})

describe('policy path resolution', () => {
  test('relative path is resolved from root dir', () =>
    withTmp(async (proj) => {
      expect(newGate(proj).resolvePolicyPath('/root', '.claude/policies/gate.dw')).toBe('/root/.claude/policies/gate.dw')
    }))

  test('absolute and tilde paths are kept', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      expect(g.resolvePolicyPath('/root', '/abs/gate.dw')).toBe('/abs/gate.dw')
      expect(g.resolvePolicyPath('/root', '~/gate.dw')).toBe(path.join(os.homedir(), 'gate.dw'))
    }))

  test('rule policy overrides top level', () =>
    withTmp(async (proj) => {
      const top = writePolicy(proj, '.claude/policies/gate.dw')
      const rule = writePolicy(proj, '.claude/policies/hooks.dw')
      const g = newGate(proj)
      const cfg = { policy: '.claude/policies/gate.dw' }
      expect((await g.policyPaths(cfg, { policy: '.claude/policies/hooks.dw' }, proj))?.policy).toBe(rule)
      expect((await g.policyPaths(cfg, {}, proj))?.policy).toBe(top)
    }))

  test('default schema is used when not configured', () =>
    withTmp(async (proj) => {
      writePolicy(proj)
      const g = newGate(proj)
      const r = await g.policyPaths({ policy: '.claude/policies/gate.dw' }, {}, proj)
      expect(r?.schema).toBe(g.defaultPolicySchema)
      expect(exists(g.defaultPolicySchema)).toBe(true)
    }))

  test('unset policy falls back to the bundled default', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      const r = await g.policyPaths({}, {}, proj)
      expect(r).toEqual({ policy: g.defaultPolicy, schema: g.defaultPolicySchema, isDefault: true })
      expect(exists(g.defaultPolicy)).toBe(true)
    }))

  test('explicit policy is not flagged as default', () =>
    withTmp(async (proj) => {
      writePolicy(proj)
      expect((await newGate(proj).policyPaths({ policy: '.claude/policies/gate.dw' }, {}, proj))?.isDefault).toBe(false)
    }))

  test('missing default policy file disables the mechanism', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      g.defaultPolicy = path.join(proj, 'ghost-default.dw')
      expect(await g.policyPaths({}, {}, proj)).toBeNull()
    }))

  test('missing policy file disables the mechanism and logs', () =>
    withTmp(async (proj) => {
      const logs: string[] = []
      expect(await newGate(proj).policyPaths({ policy: 'ghost.dw' }, {}, proj, logs)).toBeNull()
      expect(logs.some((l) => l.includes('ghost.dw'))).toBe(true)
    }))

  test('false disables the mechanism; rule false overrides a top level path; rule path overrides top level false', () =>
    withTmp(async (proj) => {
      const rule = writePolicy(proj, '.claude/policies/hooks.dw')
      writePolicy(proj)
      const g = newGate(proj)
      expect(await g.policyPaths({ policy: false }, {}, proj)).toBeNull()
      expect(await g.policyPaths({ policy: '.claude/policies/gate.dw' }, { policy: false }, proj)).toBeNull()
      expect(await g.policyPaths({ policy: false }, { match: 'x' } as never, proj)).toBeNull()
      expect((await g.policyPaths({ policy: false }, { policy: '.claude/policies/hooks.dw' }, proj))?.policy).toBe(rule)
    }))
})

describe('trace store', () => {
  test('records are scoped to their root', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      await g.appendTrace(proj, proj, 'a', 'cmd-a', 'request')
      await g.appendTrace('/other/root', '/other/root', 'b', 'cmd-b', 'request')
      expect((await g.readTrace(proj)).map((r) => r.cmd)).toEqual(['cmd-a'])
      expect((await g.readTrace('/other/root')).map((r) => r.cmd)).toEqual(['cmd-b'])
    }))

  test('timestamp is monotonic non-decreasing per root', () =>
    withTmp(async (proj) => {
      const future = Math.floor(Date.now() / 1000) + 5000
      writeTraceRecords(proj, 'sess1', [{ ts: future, root: proj, cwd: proj, name: 'a', cmd: 'a', kind: 'request' }])
      expect(await newGate(proj).appendTrace(proj, proj, 'b', 'b', 'response')).toBeGreaterThanOrEqual(future)
    }))

  test('records older than the window are pruned on write', () =>
    withTmp(async (proj) => {
      const now = Math.floor(Date.now() / 1000)
      writeTraceRecords(proj, 'sess1', [
        { ts: now - 90000, root: proj, cwd: proj, name: 'old', cmd: 'old', kind: 'error' },
        { ts: now - 60, root: proj, cwd: proj, name: 'recent', cmd: 'recent', kind: 'error' },
      ])
      await newGate(proj).appendTrace(proj, proj, 'new', 'new', 'request')
      expect(names(proj)).toEqual(['recent', 'new'])
    }))

  test('broken lines are ignored', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.dirname(tracePath(proj, 'sess1')), { recursive: true })
      fs.writeFileSync(tracePath(proj, 'sess1'), '<<broken>>\n')
      const g = newGate(proj)
      await g.appendTrace(proj, proj, 'a', 'a', 'request')
      expect((await g.readTrace(proj)).map((r) => r.name)).toEqual(['a'])
    }))
})

describe('deferred store', () => {
  test('entries are deduped by root, cwd and cmd', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      await g.deferCmd(proj, proj, 'n', 'pytest -q', 300, 'hooks')
      await g.deferCmd(proj, proj, 'n2', 'pytest -q', 60, 'hooks')
      await g.deferCmd(proj, path.join(proj, 'sub'), 'n', 'pytest -q', 300, 'sub')
      const entries = readDeferred(proj, 'sess1')
      expect(entries.length).toBe(2)
      expect(entries[0]?.timeout).toBe(300)
    }))

  test('files env of a duplicate is merged into the existing entry', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      await g.deferCmd(proj, proj, 'n', 'c', 300, 'x', { CLAUDE_GATE_FILES: 'a.py' })
      await g.deferCmd(proj, proj, 'n', 'c', 300, 'x', { CLAUDE_GATE_FILES: "b.py 'c d.py'" })
      const env = readDeferred(proj, 'sess1')[0]?.env as Record<string, string> | undefined
      expect(env?.CLAUDE_GATE_FILES).toBe("a.py b.py 'c d.py'")
    }))

  test('takeDeferred returns all and empties the store', () =>
    withTmp(async (proj) => {
      const g = newGate(proj)
      await g.deferCmd(proj, proj, 'n', 'a', 300, 'x')
      expect((await g.takeDeferred()).length).toBe(1)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))
})

const entry = (proj: string, cmd: string) => ({ root: proj, cwd: proj, name: `n${cmd.length}`, cmd, timeout: 30, label: 'x', env: {} })

describe('checks phase drains deferred', () => {
  test('runs deferred without pending checks and empties the store', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.go', run: ['true'] }] })
      const marker = path.join(proj, 'ran.txt')
      writeDeferred(proj, 'sess1', [entry(proj, `echo ok > ${marker}`)])
      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(marker)).toBe(true)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('blocks and keeps only the failed deferred', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.go', run: ['true'] }] })
      writeDeferred(proj, 'sess1', [entry(proj, 'true'), entry(proj, 'echo deferred-failed; exit 1')])
      const r = await checks(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('deferred-failed')
      expect(readDeferred(proj, 'sess1').map((e) => e.cmd)).toEqual(['echo deferred-failed; exit 1'])
    }))
})

describe('policy disabled / missing', () => {
  const runRules = async (proj: string, gateCfg: Record<string, unknown>, dogwoodBin: string) => {
    const marker = path.join(proj, 'ran.marker')
    writeGateYaml(proj, { ...gateCfg, rules: [{ match: '**/*.py', run: [`touch ${marker}`] }] })
    writeChangedFiles(proj, 'sess1', 'x.py')
    ok(await rules(proj, 'sess1', { dogwoodBin }))
    return marker
  }

  test('policy false runs commands without asking dogwood', () =>
    withTmp(async (proj) => {
      const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), { verdict: 'deny' })
      expect(exists(await runRules(proj, { policy: false }, fake))).toBe(true)
      expect(readCalls(calls)).toEqual([])
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('rule policy false overrides a top level path', () =>
    withTmp(async (proj) => {
      const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), { verdict: 'deny' })
      writePolicy(proj)
      const marker = path.join(proj, 'ran.marker')
      writeGateYaml(proj, { policy: '.claude/policies/gate.dw', rules: [{ match: '**/*.py', policy: false, run: [`touch ${marker}`] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(true)
      expect(readCalls(calls)).toEqual([])
    }))

  test('rule policy path overrides a top level false', () =>
    withTmp(async (proj) => {
      const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), { verdict: 'deny' })
      const ruleType = writePolicy(proj, '.claude/policies/hooks.dw')
      const marker = path.join(proj, 'ran.marker')
      writeGateYaml(proj, {
        policy: false,
        rules: [{ match: '**/*.py', policy: '.claude/policies/hooks.dw', run: [{ cmd: `touch ${marker}`, name: 'pkg-a' }] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(false)
      expect(readCalls(calls)[0]?.argv[1]).toBe(ruleType)
    }))

  test('missing policy file runs commands as before', () =>
    withTmp(async (proj) => {
      const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), { verdict: 'deny' })
      expect(exists(await runRules(proj, { policy: '.claude/policies/ghost.dw' }, fake))).toBe(true)
      expect(readCalls(calls)).toEqual([])
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('missing policy file is logged by runRules', () =>
    withTmp(async (proj) => {
      const g = newGate(proj, 'sess1', { phase: 'rules' })
      const logs: string[] = []
      await g.runRules({ policy: '.claude/policies/ghost.dw', rules: [{ match: '**/*.py', run: ['true'] }] }, ['x.py'], logs, proj, new PolicyState())
      expect(logs.some((l) => l.includes('ghost.dw'))).toBe(true)
    }))
})

describe('default policy', () => {
  const project = (proj: string, name = 'pkg-a', fakeOpts: FakeDogwoodOpts = {}) => {
    const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), fakeOpts)
    const marker = path.join(proj, 'ran.marker')
    writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: `touch ${marker}`, name }] }] })
    writeChangedFiles(proj, 'sess1', 'x.py')
    return { fake, calls, marker }
  }

  test('bundled default policy is used when policy is unset', () =>
    withTmp(async (proj) => {
      const { fake, calls, marker } = project(proj)
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(true)
      expect(readCalls(calls)[0]?.argv[1]).toBe(newGate(proj).defaultPolicy)
    }))

  test('default policy deny skips and defers', () =>
    withTmp(async (proj) => {
      const { fake, marker } = project(proj, 'pkg-a', { deny: ['pkg-a'] })
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))

  test('missing dogwood runs the command without deferring', () =>
    withTmp(async (proj) => {
      const { marker } = project(proj)
      ok(await rules(proj, 'sess1', { dogwoodBin: path.join(proj, 'nope') }))
      expect(exists(marker)).toBe(true)
      expect(readDeferred(proj, 'sess1')).toEqual([])
      // 判定していないので request は残らない。実行結果だけは履歴に積む。
      expect(kinds(proj)).toEqual(['response'])
    }))

  test('broken dogwood still skips and defers', () =>
    withTmp(async (proj) => {
      // fail-open するのはバイナリ不在のときだけ。dogwood は在るのに評価できないケースはスキップして控えに積む。
      for (const mode of ['fail', 'broken', 'empty'] as const) {
        const sub = path.join(proj, mode)
        fs.mkdirSync(sub)
        const { fake, marker } = project(sub, 'pkg-a', { mode })
        ok(await rules(sub, 'sess1', { dogwoodBin: fake }))
        expect(exists(marker)).toBe(false)
        expect(readDeferred(sub, 'sess1').length).toBe(1)
      }
    }))

  test('missing default policy file runs the command', () =>
    withTmp(async (proj) => {
      const { fake, calls, marker } = project(proj, 'pkg-a', { verdict: 'deny' })
      // Gate インスタンスの既定ポリシーを差し替えて main を呼ぶ。
      const g = newGate(proj, 'sess1', { phase: 'rules', dogwoodBin: fake })
      g.defaultPolicy = path.join(proj, 'ghost-default.dw')
      expect(await g.main()).toBe(0)
      expect(exists(marker)).toBe(true)
      expect(readCalls(calls)).toEqual([])
    }))

  test('default policy applies to consistency checks', () =>
    withTmp(async (proj) => {
      const [fake] = writeFakeDogwood(path.join(proj, 'bin'), { deny: ['chk-cmd'] })
      const marker = path.join(proj, 'chk.marker')
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [{ cmd: `touch ${marker}`, name: 'chk-cmd' }] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      ok(await checks(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))

  test('missing policy file is logged by the named checks too', () =>
    withTmp(async (proj) => {
      const [fake] = writeFakeDogwood(path.join(proj, 'bin'))
      writeGateYaml(proj, {
        policy: '.claude/policies/ghost.dw',
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: ['true'] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      await rules(proj, 'sess1', { dogwoodBin: fake })
      const r = await checks(proj, 'sess1', { dogwoodBin: fake, stopHookActive: true })
      expect(r.exitCode).toBe(0)
    }))
})

/** policy を設定した gate.yaml と偽 dogwood を用意し、[バイナリ, 呼び出し記録] を返す。 */
function policyProject(proj: string, run: unknown[], fakeOpts: FakeDogwoodOpts = {}): [string, string] {
  const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), fakeOpts)
  writePolicy(proj)
  writeGateYaml(proj, { policy: '.claude/policies/gate.dw', rules: [{ match: '**/*.py', run }] })
  writeChangedFiles(proj, 'sess1', 'x.py')
  return [fake, calls]
}

describe('policy decisions', () => {
  test('allow runs the command and records request and response', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'ran.marker')
      const [fake, calls] = policyProject(proj, [{ cmd: `touch ${marker}`, name: 'pkg-a' }])
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(true)
      expect(readCalls(calls).length).toBe(1)
      expect(readTraceRecords(proj, 'sess1').map((r) => [r.kind, r.name])).toEqual([
        ['request', 'pkg-a'],
        ['response', 'pkg-a'],
      ])
    }))

  test('allow with a failing command records error', () =>
    withTmp(async (proj) => {
      const [fake] = policyProject(proj, [{ cmd: 'false', name: 'pkg-a' }])
      expect((await rules(proj, 'sess1', { dogwoodBin: fake })).exitCode).toBe(2)
      expect(kinds(proj)).toEqual(['request', 'error'])
    }))

  test('deny skips the command without failing the phase', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'ran.marker')
      const [fake] = policyProject(proj, [{ cmd: `touch ${marker}`, name: 'pkg-a' }], { deny: ['pkg-a'] })
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(false)
      // スキップは失敗ではないので、成功時と同じくファイルは CHANGED から外れる
      expect(exists(path.join(proj, '.claude', '.gate-status', 'changed_files.sess1.txt'))).toBe(false)
      expect(kinds(proj)).toEqual(['request'])
      const entries = readDeferred(proj, 'sess1')
      expect(entries.length).toBe(1)
      expect(entries[0]?.cmd).toBe(`touch ${marker}`)
      expect(entries[0]?.name).toBe('pkg-a')
    }))

  test('name defaults to the slug of the command', () =>
    withTmp(async (proj) => {
      const [fake] = policyProject(proj, ['true'])
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(names(proj)).toEqual([slug('true'), slug('true')])
    }))
})

describe('policy evaluation failure', () => {
  const assertSkippedAndDeferred = async (proj: string, fake: string) => {
    ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
    expect(exists(path.join(proj, 'ran.marker'))).toBe(false)
    expect(readDeferred(proj, 'sess1').length).toBe(1)
    expect(readTraceRecords(proj, 'sess1')).toEqual([])
  }

  test('dogwood binary missing', () =>
    withTmp(async (proj) => {
      policyProject(proj, [`touch ${path.join(proj, 'ran.marker')}`])
      await assertSkippedAndDeferred(proj, path.join(proj, 'nope'))
    }))

  for (const mode of ['fail', 'broken', 'empty'] as const) {
    test(`dogwood mode ${mode}`, () =>
      withTmp(async (proj) => {
        const [fake] = policyProject(proj, [`touch ${path.join(proj, 'ran.marker')}`], { mode })
        await assertSkippedAndDeferred(proj, fake)
      }))
  }
})

describe('rule policy override', () => {
  test('rule policy is passed to dogwood instead of the top level one', () =>
    withTmp(async (proj) => {
      const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'))
      writePolicy(proj, '.claude/policies/gate.dw')
      const rulePolicy = writePolicy(proj, '.claude/policies/hooks.dw')
      writeGateYaml(proj, { policy: '.claude/policies/gate.dw', rules: [{ match: '**/*.py', policy: '.claude/policies/hooks.dw', run: ['true'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      const argv = readCalls(calls)[0]?.argv
      expect(argv?.[0]).toBe('replay')
      expect(argv?.[1]).toBe(rulePolicy)
    }))
})

describe('deferred drain', () => {
  function twoRuleProject(proj: string) {
    const [fake, calls] = writeFakeDogwood(path.join(proj, 'bin'), { deny: ['pkg-a'] })
    writePolicy(proj)
    const a = path.join(proj, 'a.marker')
    const b = path.join(proj, 'b.marker')
    writeGateYaml(proj, {
      policy: '.claude/policies/gate.dw',
      rules: [
        { match: 'a.py', run: [{ cmd: `touch ${a}`, name: 'pkg-a' }] },
        { match: 'b.py', run: [{ cmd: `touch ${b}`, name: 'pkg-b' }] },
      ],
    })
    return { fake, calls, a, b }
  }

  test('deferred is drained on the run where a command was allowed', () =>
    withTmp(async (proj) => {
      const { fake, calls, a, b } = twoRuleProject(proj)
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(a)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)

      writeChangedFiles(proj, 'sess1', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(b)).toBe(true)
      expect(exists(a)).toBe(true)
      expect(readDeferred(proj, 'sess1')).toEqual([])
      // 控えの消化はポリシー判定をバイパスする（deny のままでは永久に消化されない）
      expect(readCalls(calls).length).toBe(2)
    }))

  test('drained command result is recorded without a request', () =>
    withTmp(async (proj) => {
      const { fake } = twoRuleProject(proj)
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      writeChangedFiles(proj, 'sess1', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(readTraceRecords(proj, 'sess1').map((r) => [r.kind, r.name])).toEqual([
        ['request', 'pkg-a'],
        ['request', 'pkg-b'],
        ['response', 'pkg-b'],
        ['response', 'pkg-a'],
      ])
    }))

  test('a command deferred in the same run as an allow is not drained that run', () =>
    withTmp(async (proj) => {
      const { fake, a, b } = twoRuleProject(proj)
      writeChangedFiles(proj, 'sess1', 'a.py', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(a)).toBe(false)
      expect(exists(b)).toBe(true)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))

  test('an entry deferred in a prior run is drained on a later allowed run', () =>
    withTmp(async (proj) => {
      const { fake, a } = twoRuleProject(proj)
      writeChangedFiles(proj, 'sess1', 'a.py', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(a)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)

      writeChangedFiles(proj, 'sess1', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(a)).toBe(true)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('a key re-deferred after being allowed in the same run is not drained that run', () =>
    withTmp(async (proj) => {
      const counter = path.join(proj, 'count.txt')
      writePolicy(proj)
      writeGateYaml(proj, {
        policy: '.claude/policies/gate.dw',
        rules: [
          { match: 'a.py', run: [{ cmd: `echo x >> ${counter}`, name: 'pkg-a' }] },
          { match: 'b.py', run: [{ cmd: `echo x >> ${counter}`, name: 'pkg-a' }] },
        ],
      })
      const [seed] = writeFakeDogwood(path.join(proj, 'seed-bin'), { deny: ['pkg-a'] })
      const [flip] = writeFakeDogwood(path.join(proj, 'flip-bin'), { deny_after_first_call: ['pkg-a'] })
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: seed }))
      expect(readDeferred(proj, 'sess1').length).toBe(1)

      writeChangedFiles(proj, 'sess1', 'a.py', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: flip }))
      expect(read(counter).split('\n').filter(Boolean).length).toBe(1)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))

  test('a deferred entry with a vanished cwd is discarded without running', () =>
    withTmp(async (proj) => {
      const { fake, b } = twoRuleProject(proj)
      const ghostMarker = path.join(proj, 'ghost.marker')
      writeDeferred(proj, 'sess1', [{ root: proj, cwd: path.join(proj, 'ghost'), name: 'ghost', cmd: `touch ${ghostMarker}`, timeout: 300, label: 'ghost' }])
      writeChangedFiles(proj, 'sess1', 'b.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(b)).toBe(true)
      expect(exists(ghostMarker)).toBe(false)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('an allow consumes the same command left in the deferred store', () =>
    withTmp(async (proj) => {
      const counter = path.join(proj, 'count.txt')
      writePolicy(proj)
      writeGateYaml(proj, { policy: '.claude/policies/gate.dw', rules: [{ match: 'a.py', run: [{ cmd: `echo x >> ${counter}`, name: 'pkg-a' }] }] })
      const [denyBin] = writeFakeDogwood(path.join(proj, 'deny-bin'), { deny: ['pkg-a'] })
      const [allowBin] = writeFakeDogwood(path.join(proj, 'allow-bin'))
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: denyBin }))
      expect(readDeferred(proj, 'sess1').length).toBe(1)
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: allowBin }))
      expect(read(counter).split('\n').filter(Boolean).length).toBe(1)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('deferred is not drained when nothing was allowed', () =>
    withTmp(async (proj) => {
      const { fake, a } = twoRuleProject(proj)
      writeChangedFiles(proj, 'sess1', 'a.py')
      for (let i = 0; i < 2; i++) ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(a)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))
})

describe('checks phase with policy', () => {
  const reserved = (proj: string, checkRun: unknown[], fakeOpts: FakeDogwoodOpts = {}) => {
    const [fake] = writeFakeDogwood(path.join(proj, 'bin'), fakeOpts)
    writePolicy(proj)
    writeGateYaml(proj, {
      policy: '.claude/policies/gate.dw',
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [{ name: 'chk', run: checkRun }],
    })
    writeChangedFiles(proj, 'sess1', 'x.py')
    return fake
  }

  test('a consistency check command is denied and skipped', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'chk.marker')
      const fake = reserved(proj, [{ cmd: `touch ${marker}`, name: 'chk-cmd' }], { deny: ['chk-cmd'] })
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      ok(await checks(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(marker)).toBe(false)
      expect(readDeferred(proj, 'sess1').length).toBe(1)
    }))

  test('checks phase drains the deferred store along with reserved checks', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'chk.marker')
      const deferredMarker = path.join(proj, 'deferred.marker')
      const fake = reserved(proj, [`touch ${marker}`])
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      writeDeferred(proj, 'sess1', [{ root: proj, cwd: proj, name: 'left-over', cmd: `touch ${deferredMarker}`, timeout: 300, label: '.' }])
      ok(await checks(proj, 'sess1', { dogwoodBin: fake, stopHookActive: true }))
      expect(exists(marker)).toBe(true)
      expect(exists(deferredMarker)).toBe(true)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('a reserved check that ran a command consumes the same command left in the deferred store', () =>
    withTmp(async (proj) => {
      const counter = path.join(proj, 'count.txt')
      const cmd = `echo x >> ${counter}`
      const fake = reserved(proj, [{ cmd, name: 'chk-cmd' }])
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      writeDeferred(proj, 'sess1', [{ root: proj, cwd: proj, name: 'chk-cmd', cmd, timeout: 300, label: '.' }])
      ok(await checks(proj, 'sess1', { dogwoodBin: fake, stopHookActive: true }))
      expect(read(counter).split('\n').filter(Boolean).length).toBe(1)
      expect(readDeferred(proj, 'sess1')).toEqual([])
    }))

  test('a deferred command the reserved check did not run is still executed', () =>
    withTmp(async (proj) => {
      const counter = path.join(proj, 'count.txt')
      const cmd = `echo x >> ${counter}`
      const fake = reserved(proj, [{ cmd, name: 'chk-cmd' }], { deny: ['chk-cmd'] })
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      writeDeferred(proj, 'sess1', [{ root: proj, cwd: proj, name: 'other', cmd: `echo y >> ${counter}`, timeout: 300, label: '.' }])
      ok(await checks(proj, 'sess1', { dogwoodBin: fake, stopHookActive: true }))
      expect(read(counter).split('\n').filter(Boolean)).toEqual(['y'])
    }))
})

describe('policy state file naming', () => {
  test('state files are split by state id', () =>
    withTmp(async (proj) => {
      const [fake] = policyProject(proj, [{ cmd: `touch ${path.join(proj, 'ran.marker')}`, name: 'pkg-a' }], { deny: ['pkg-a'] })
      ok(await rules(proj, 'sess1', { dogwoodBin: fake }))
      expect(exists(tracePath(proj, 'sess1'))).toBe(true)
      expect(exists(deferredPath(proj, 'sess1'))).toBe(true)
    }))

  test('state files carry the agent suffix', () =>
    withTmp(async (proj) => {
      const [fake] = policyProject(proj, [{ cmd: `touch ${path.join(proj, 'ran.marker')}`, name: 'pkg-a' }], { deny: ['pkg-a'] })
      writeChangedFiles(proj, 'sess1--agent1', 'x.py')
      ok(await rules(proj, 'sess1', { dogwoodBin: fake, agentId: 'agent1' }))
      expect(exists(tracePath(proj, 'sess1--agent1'))).toBe(true)
      expect(exists(deferredPath(proj, 'sess1--agent1'))).toBe(true)
      expect(exists(tracePath(proj, 'sess1'))).toBe(false)
      expect(exists(deferredPath(proj, 'sess1'))).toBe(false)
    }))
})
