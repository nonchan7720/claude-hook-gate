import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { allStop } from '../src/all-stop.ts'
import * as hooks from '../src/hooks.ts'
import type { Dict } from '../src/pyutil.ts'
import { recordChanges } from '../src/record-changes.ts'
import { resetGate } from '../src/reset-gate.ts'
import { notePendingReview, parseStopReview, pendingPath, roundsPath, stopReview } from '../src/stop-review.ts'
import { writeGateYaml } from './helpers/gate.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

describe('parseStopReview', () => {
  test('未指定・false は無効、true は既定値', () => {
    expect(parseStopReview(undefined)).toBeUndefined()
    expect(parseStopReview(false)).toBeUndefined()
    expect(parseStopReview({ enabled: false })).toBeUndefined()
    expect(parseStopReview(true)).toEqual({ effort: 'xhigh', match: [], maxRounds: 1, prompt: '', subagents: true })
  })

  test('各キーを読み、不正な値は既定値にする', () => {
    expect(parseStopReview({ effort: 'max', match: 'src/**', max_rounds: 2, prompt: ' 追加の指示 \n', subagents: false })).toEqual({
      effort: 'max',
      match: ['src/**'],
      maxRounds: 2,
      prompt: '追加の指示',
      subagents: false,
    })
    expect(parseStopReview({ effort: 'ultra', max_rounds: 0 })).toMatchObject({ effort: 'xhigh', maxRounds: 1 })
    expect(parseStopReview({ effort: false })).toMatchObject({ effort: null })
  })
})

describe('stop-review', () => {
  let proj: string
  const io = (lang: 'ja' | 'en' = 'ja') => makeIo({ projectDir: proj, lang })
  const run = (payload: Dict = {}) => stopReview(io(), { session_id: 'sess1', ...payload })
  const note = (stateId: string, ...rels: string[]) =>
    notePendingReview(
      io(),
      stateId,
      rels.map((r) => path.join(proj, r)),
    )
  const reasonOf = (stdout: string): string => (JSON.parse(stdout) as { reason: string }).reason

  beforeEach(() => {
    proj = tmpDir()
  })
  afterEach(() => rmTree(proj))

  test('gate.yaml が無い・stop_review が無いときは何もしない（控えは消す）', async () => {
    expect((await run()).exitCode).toBe(0)
    writeGateYaml(proj, { rules: [] })
    await note('sess1', 'a.ts')
    const r = await run()
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(fs.existsSync(pendingPath(io(), 'sess1'))).toBe(false)
  })

  test('変更が無ければ止めない', async () => {
    writeGateYaml(proj, { stop_review: true })
    expect((await run()).exitCode).toBe(0)
  })

  test('変更があれば 1 回ブロックし、effort のスキルと変更ファイルを reason に入れる。次の Stop は通す', async () => {
    writeGateYaml(proj, { stop_review: { effort: 'high', prompt: 'マイグレーションも確認' } })
    await note('sess1', 'src/a.ts', 'README.md')
    const r = await run()
    expect(r.exitCode).toBe(2)
    const reason = reasonOf(r.stdout)
    expect(reason).toContain('[stop-review]')
    expect(reason).toContain('1/1')
    expect(reason).toContain('feedback-gate:effort-high')
    expect(reason).toContain('- src/a.ts')
    expect(reason).toContain('- README.md')
    expect(reason.endsWith('マイグレーションも確認')).toBe(true)

    const again = await run({ stop_hook_active: true })
    expect(again.exitCode).toBe(0)
    expect(again.reportConsumed).toBe(true)
    expect(fs.existsSync(roundsPath(io(), 'sess1'))).toBe(false)
    // 状態が消えたあとの Stop は印を返さない
    expect((await run({ stop_hook_active: true })).reportConsumed).toBeUndefined()
  })

  test('見直し中の修正は max_rounds 回まで再度見直させる', async () => {
    writeGateYaml(proj, { stop_review: { max_rounds: 2 } })
    await note('sess1', 'a.ts')
    expect((await run()).exitCode).toBe(2)
    await note('sess1', 'b.ts')
    const second = await run({ stop_hook_active: true })
    expect(second.exitCode).toBe(2)
    expect(reasonOf(second.stdout)).toContain('2/2')
    expect(reasonOf(second.stdout)).not.toContain('- a.ts')
    await note('sess1', 'c.ts')
    expect((await run({ stop_hook_active: true })).exitCode).toBe(0)
    // 打ち切りで状態が消え、次のターンの変更はまた見直す
    await note('sess1', 'd.ts')
    expect((await run()).exitCode).toBe(2)
  })

  test('中断などで回数が残っていても、新しいターンの Stop（stop_hook_active でない）は 1 回目から見直す', async () => {
    writeGateYaml(proj, { stop_review: true })
    await note('sess1', 'a.ts')
    expect((await run()).exitCode).toBe(2)
    // ここでターンが中断され、review_rounds が残ったまま次のターンで編集した
    await note('sess1', 'b.ts')
    const next = await run()
    expect(next.exitCode).toBe(2)
    expect(reasonOf(next.stdout)).toContain('1/1')
    // 同じターンの続き（ブロック後）の修正は、max_rounds: 1 なので見直さずに通す
    await note('sess1', 'c.ts')
    expect((await run({ stop_hook_active: true })).exitCode).toBe(0)
  })

  test('控えに書けなくても notePendingReview は例外を投げない', async () => {
    const base = io()
    const broken = { ...base, writeFile: () => Promise.reject(new Error('read-only')) }
    await notePendingReview(broken, 'sess1', [path.join(proj, 'a.ts')])
  })

  test('match に合う変更だけを対象にする', async () => {
    writeGateYaml(proj, { stop_review: { match: ['src/**/*.ts'] } })
    await note('sess1', 'README.md')
    expect((await run()).exitCode).toBe(0)
    await note('sess1', 'README.md', 'src/x/a.ts')
    const r = await run()
    expect(r.exitCode).toBe(2)
    expect(reasonOf(r.stdout)).toContain('- src/x/a.ts')
    expect(reasonOf(r.stdout)).not.toContain('README.md')
  })

  test('effort: false ならスキルの手順を出さない。英語の文面', async () => {
    writeGateYaml(proj, { stop_review: { effort: false } })
    await note('sess1', 'a.ts')
    const r = await stopReview(io('en'), { session_id: 'sess1' })
    const reason = reasonOf(r.stdout)
    expect(reason).toContain('Before you stop')
    expect(reason).not.toContain('feedback-gate:effort-')
  })

  test('サブエージェントは自分の控えだけを見る。subagents: false なら行わない', async () => {
    writeGateYaml(proj, { stop_review: true })
    await note('sess1--ag1', 'a.ts')
    expect((await run()).exitCode).toBe(0)
    expect((await run({ agent_id: 'ag1' })).exitCode).toBe(2)

    writeGateYaml(proj, { stop_review: { subagents: false } })
    await note('sess1--ag1', 'a.ts')
    expect((await run({ agent_id: 'ag1' })).exitCode).toBe(0)
  })

  test('変更ファイルが多いときは 30 件で切る', async () => {
    writeGateYaml(proj, { stop_review: true })
    await note('sess1', ...Array.from({ length: 33 }, (_, i) => `f${i}.ts`))
    const reason = reasonOf((await run()).stdout)
    expect(reason.split('\n').filter((l) => /^- f\d+\.ts$/.test(l)).length).toBe(30)
    expect(reason).toContain('3')
  })

  test('recordChanges が控えに足し、allStop / subagentStop が見直しでブロックする', async () => {
    writeGateYaml(proj, { stop_review: true })
    const file = path.join(proj, 'a.ts')
    fs.writeFileSync(file, '')
    await recordChanges(io(), { session_id: 'sess1', tool_input: { file_path: file } })
    const r = await allStop(io(), { session_id: 'sess1' })
    expect(r.exitCode).toBe(2)
    expect(reasonOf(r.stdout.trim().split('\n').pop() ?? '')).toContain('- a.ts')
    expect((await allStop(io(), { session_id: 'sess1', stop_hook_active: true })).exitCode).toBe(0)

    await recordChanges(io(), { session_id: 'sess1', agent_id: 'ag1', tool_input: { file_path: file } })
    const sub = await hooks.subagentStop(io(), 'sess1', { session_id: 'sess1', agent_id: 'ag1' })
    expect(sub.outcome.block).toContain('[stop-review]')
  })

  test('SessionStart(startup) で控えを消す', async () => {
    writeGateYaml(proj, { stop_review: true })
    await note('sess1', 'a.ts')
    await note('sess1--ag1', 'a.ts')
    await resetGate(io(), { session_id: 'sess1', source: 'startup' })
    expect(fs.existsSync(pendingPath(io(), 'sess1'))).toBe(false)
    expect(fs.existsSync(pendingPath(io(), 'sess1--ag1'))).toBe(false)
  })
})
