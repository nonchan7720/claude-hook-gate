import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseItem, SESSION_START_MAX_CHARS, sessionStartGate } from '../src/gate-session-start.ts'
import { sessionStart } from '../src/hooks.ts'
import { exists, writeGateYaml } from './helpers/gate.ts'
import { MISSING_DOGWOOD_BIN, makeIo, withTmp } from './helpers/node-io.ts'

const io = (proj: string) => makeIo({ projectDir: proj, lang: 'en', env: { DOGWOOD_BIN: MISSING_DOGWOOD_BIN } })
const start = (proj: string, payload: Record<string, unknown> = {}) => sessionStartGate(io(proj), { session_id: 's1', source: 'startup', ...payload })
const logs = (proj: string): string[] => {
  const dir = path.join(proj, '.claude', '.gate-status', 'logs', 's1')
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : []
}

// シェルの展開（${...}）を含むので、テンプレート文字列と誤認されないよう分けて組み立てる
const ENV_CMD = ['echo "$CLAUDE_PROJECT_DIR|$CLAUDE_SESSION_ID|$CLAUDE_SESSION_SOURCE|', '$', '{CLAUDE_AGENT_ID-unset}|[$CLAUDE_GATE_FILES]|$PWD"'].join('')

describe('session_start phase', () => {
  test('labelled stdout in declaration order; empty stdout injects nothing', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'slow', cmd: 'sleep 0.3; echo first' },
          { name: 'quiet', cmd: 'true' },
          'echo second',
          { name: 'last', cmd: 'echo "  third  "' },
        ],
      })
      const r = await start(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('[gate] session_start: slow\nfirst\n\n[gate] session_start: echo_second\nsecond\n\n[gate] session_start: last\nthird\n')
      expect(logs(proj).length).toBe(4)
    }))

  test('no gate.yaml, no session_start, or empty list: nothing', () =>
    withTmp(async (proj) => {
      expect((await start(proj)).stdout).toBe('')
      writeGateYaml(proj, { rules: [] })
      expect((await start(proj)).stdout).toBe('')
      writeGateYaml(proj, { session_start: [] })
      expect((await start(proj)).stdout).toBe('')
    }))

  test('total output is capped with a truncation note', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { session_start: [{ name: 'big', cmd: 'yes xxxxxxxxxx | head -n 3000' }] })
      const r = await start(proj)
      expect(r.stdout).toContain('output was truncated')
      expect(r.stdout.length).toBeLessThan(SESSION_START_MAX_CHARS + 200)
    }))

  test('truncation never splits a surrogate pair', () =>
    withTmp(async (proj) => {
      const header = '[gate] session_start: big\n'
      // 絵文字（UTF-16 で 2 単位）が 8192 の境界をまたぐ位置に置く。
      const pad = SESSION_START_MAX_CHARS - header.length - 1
      writeGateYaml(proj, { session_start: [{ name: 'big', cmd: `head -c ${pad} /dev/zero | tr '\\0' a; printf '\\360\\237\\230\\200 tail'` }] })
      const r = await start(proj)
      const body = r.stdout.split('\n[gate] session_start output')[0] as string
      expect(r.stdout).toContain('output was truncated')
      expect(body.length).toBeLessThanOrEqual(SESSION_START_MAX_CHARS)
      expect(body).not.toContain('\ufffd')
      expect(/[\ud800-\udbff]$/.test(body)).toBe(false)
      expect(body.endsWith('a')).toBe(true)
    }))

  test('hook JSON output: additionalContext is taken, systemMessage is surfaced, no usable context injects nothing; plain text stays', () =>
    withTmp(async (proj) => {
      const json = (o: unknown) => `printf '%s' '${JSON.stringify(o)}'`
      writeGateYaml(proj, {
        session_start: [
          { name: 'j1', cmd: json({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'from json' }, systemMessage: 'hello user' }) },
          { name: 'j2', cmd: json({ hookSpecificOutput: { additionalContext: '' }, other: 1 }) },
          { name: 'j3', cmd: json({ foo: 'bar' }) },
          { name: 'plain', cmd: 'echo [1,2]' },
        ],
      })
      const r = await start(proj)
      expect(r.stdout).toBe('[gate] session_start: j1\nfrom json\n\n[gate] session_start: plain\n[1,2]\n')
      expect(r.systemMessage).toBe('hello user')
    }))

  test('a timeout above 600 is capped to 600', () => {
    expect(parseItem({ cmd: 'x', timeout: 9999 })?.timeout).toBe(600)
    expect(parseItem({ cmd: 'x' })?.timeout).toBe(10)
  })

  test('a failing command is reported once on stderr, exit 0, and others still run', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'bad', cmd: 'echo oops; echo err >&2; exit 3' },
          { name: 'good', cmd: 'echo fine' },
        ],
      })
      const r = await start(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toBe('[gate] session_start: good\nfine\n')
      expect(r.stderr).toContain('session_start: bad failed (exit status 3)')
      expect(r.systemMessage).toBe(r.stderr.trimEnd())
      expect(r.stderr.match(/bad failed/g)?.length).toBe(1)
      const log = logs(proj).find((l) => path.basename(l).startsWith('bad.'))
      expect(log).toBeDefined()
      expect(r.stderr).toContain(log as string)
      expect(fs.readFileSync(log as string, 'utf8')).toContain('err')
    }))

  test('a timed-out command is a failure, not a block', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'hang', cmd: 'sleep 5', timeout: 1 },
          { name: 'ok', cmd: 'echo up' },
        ],
      })
      const r = await start(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('up')
      expect(r.stderr).toContain('hang failed (timed out after 1s)')
    }))

  test('on: filters by source (string and list); unknown values never match', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'a', cmd: 'echo A:$CLAUDE_SESSION_SOURCE', on: 'startup' },
          { name: 'b', cmd: 'echo B', on: ['resume', 'compact'] },
          { name: 'c', cmd: 'echo C', on: ['bogus'] },
          { name: 'd', cmd: 'echo D' },
        ],
      })
      expect((await start(proj, { source: 'startup' })).stdout).toBe('[gate] session_start: a\nA:startup\n\n[gate] session_start: d\nD\n')
      expect((await start(proj, { source: 'compact' })).stdout).toBe('[gate] session_start: b\nB\n\n[gate] session_start: d\nD\n')
      expect((await start(proj, { source: undefined })).stdout).toBe('[gate] session_start: d\nD\n')
    }))

  test('on: works unquoted, although YAML 1.1 reads the key on as true', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
      fs.writeFileSync(
        path.join(proj, '.claude', 'gate.yaml'),
        'session_start:\n  - name: a\n    cmd: echo A\n    on: [startup, clear]\n  - name: b\n    cmd: echo B\n    on: resume\n',
      )
      expect((await start(proj, { source: 'startup' })).stdout).toBe('[gate] session_start: a\nA\n')
      expect((await start(proj, { source: 'resume' })).stdout).toBe('[gate] session_start: b\nB\n')
      expect((await start(proj, { source: 'compact' })).stdout).toBe('')
      // 引用した "on" が空でも、引用しない on: の値を使う。
      fs.writeFileSync(path.join(proj, '.claude', 'gate.yaml'), 'session_start:\n  - name: a\n    cmd: echo A\n    on: [resume]\n    "on":\n')
      expect((await start(proj, { source: 'startup' })).stdout).toBe('')
    }))

  test('skipped when the payload has agent_id', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { session_start: [{ name: 'a', cmd: 'echo A' }] })
      const r = await start(proj, { agent_id: 'sub1' })
      expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
      expect(logs(proj)).toEqual([])
    }))

  test('environment: project dir, session id, source; agent id unset; files empty', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          {
            name: 'env',
            cmd: ENV_CMD,
          },
        ],
      })
      const r = await start(proj, { source: 'clear' })
      expect(r.stdout).toBe(`[gate] session_start: env\n${proj}|s1|clear|unset|[]|${proj}\n`)
    }))

  test('background: returns immediately, injects nothing, output reaches the log', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'bg', cmd: 'sleep 2; echo done > "$CLAUDE_PROJECT_DIR/bg.out"; echo hello', background: true },
          { name: 'fg', cmd: 'echo now' },
        ],
      })
      const t0 = Date.now()
      const r = await start(proj)
      expect(Date.now() - t0).toBeLessThan(1500)
      expect(r.stdout).toBe('[gate] session_start: fg\nnow\n')
      expect(r.stderr).toBe('')
      expect(logs(proj).some((l) => path.basename(l).startsWith('bg.'))).toBe(true)
      expect(exists(path.join(proj, 'bg.out'))).toBe(false)
      for (let i = 0; i < 50 && !exists(path.join(proj, 'bg.out')); i++) await Bun.sleep(100)
      expect(exists(path.join(proj, 'bg.out'))).toBe(true)
      const log = logs(proj).find((l) => path.basename(l).startsWith('bg.')) as string
      expect(fs.readFileSync(log, 'utf8')).toContain('hello')
    }))

  test('rules phase still works when rules is absent', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { session_start: [{ cmd: 'echo x' }] })
      const { rules, checks } = await import('./helpers/gate.ts')
      expect((await rules(proj)).exitCode).toBe(0)
      expect((await checks(proj)).exitCode).toBe(0)
    }))

  test('sessionStart hook carries the output as additionalContext', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { session_start: [{ name: 'ctx', cmd: 'echo hi' }] })
      const r = await sessionStart(io(proj), 's1', { session_id: 's1', source: 'startup' })
      expect(r.outcome.additionalContext?.join('\n')).toContain('[gate] session_start: ctx\nhi')
      expect(r.outcome.systemMessage).toBeUndefined()
    }))

  test('sessionStart hook carries failure notes as outcome.systemMessage', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        session_start: [
          { name: 'bad', cmd: 'exit 2' },
          { name: 'good', cmd: 'echo ok' },
        ],
      })
      const r = await sessionStart(io(proj), 's1', { session_id: 's1', source: 'startup' })
      expect(r.outcome.systemMessage).toContain('session_start: bad failed (exit status 2)')
      expect(r.outcome.systemMessage).toContain('.gate-status/logs/s1/bad.')
      expect(r.outcome.additionalContext?.join('\n')).toContain('good')
      expect(r.outcome.block).toBeUndefined()
    }))
})
