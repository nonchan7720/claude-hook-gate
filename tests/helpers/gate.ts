// gate 系テストの共通ヘルパー（Python 版 test_stop_gate.py のヘルパーに対応）。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Gate, runGate } from '../../src/gate.ts'
import type { ScriptResult } from '../../src/io.ts'
import { MISSING_DOGWOOD_BIN, makeIo } from './node-io.ts'

export type GateOpts = { stopHookActive?: boolean; agentId?: string; phase?: string; dogwoodBin?: string }

const ioFor = (proj: string, dogwoodBin?: string) => makeIo({ projectDir: proj, env: { DOGWOOD_BIN: dogwoodBin ?? MISSING_DOGWOOD_BIN } })

/** gate を1回実行する（phase 省略時は checks）。 */
export const gate = (proj: string, session = 'sess1', opts: GateOpts = {}): Promise<ScriptResult> =>
  runGate(ioFor(proj, opts.dogwoodBin), { sessionId: session, agentId: opts.agentId, phase: opts.phase, stopHookActive: opts.stopHookActive })

/** 状態ファイルの操作に使う Gate インスタンス（main() は呼ばない）。 */
export const newGate = (proj: string, session = 'sess1', opts: GateOpts = {}): Gate =>
  new Gate(ioFor(proj, opts.dogwoodBin), { sessionId: session, agentId: opts.agentId, phase: opts.phase, stopHookActive: opts.stopHookActive })

export const rules = (proj: string, session = 'sess1', opts: GateOpts = {}) => gate(proj, session, { ...opts, phase: 'rules' })
export const checks = (proj: string, session = 'sess1', opts: GateOpts = {}) => gate(proj, session, { ...opts, phase: 'checks' })

export const touch = (...parts: string[]): string => {
  const p = path.join(...parts)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  return p
}

export const exists = (p: string): boolean => fs.existsSync(p)
export const read = (p: string): string => fs.readFileSync(p, 'utf8')
export const lines = (p: string): string[] =>
  read(p)
    .split('\n')
    .filter((l) => l.trim() !== '')

export function writeGateYaml(proj: string, obj: unknown): void {
  const claudeDir = path.join(proj, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  // JSON は YAML のサブセットなので、同梱パーサで読める。
  fs.writeFileSync(path.join(claudeDir, 'gate.yaml'), JSON.stringify(obj))
}

const stateDir = (proj: string) => path.join(proj, '.claude', '.gate-status')
export const statePath = (proj: string, name: string, id: string, ext: string) => path.join(stateDir(proj), `${name}.${id}.${ext}`)

export function writeChangedFiles(proj: string, sessionId: string, ...rels: string[]): void {
  fs.mkdirSync(stateDir(proj), { recursive: true })
  fs.writeFileSync(changedPath(proj, sessionId), rels.map((p) => `${p}\n`).join(''))
}

export const changedPath = (proj: string, id: string) => statePath(proj, 'changed_files', id, 'txt')
export const sidecarPath = (proj: string, id: string) => statePath(proj, 'gate_passed', id, 'txt')
export const pendingPath = (proj: string, id: string) => statePath(proj, 'gate_pending_checks', id, 'json')
export const attemptsPath = (proj: string, id: string) => statePath(proj, 'gate_attempts', id, 'txt')
export const tracePath = (proj: string, id: string) => statePath(proj, 'gate_trace', id, 'jsonl')
export const deferredPath = (proj: string, id: string) => statePath(proj, 'gate_deferred', id, 'json')
export const attemptsCount = (proj: string, id: string) => read(attemptsPath(proj, id)).trim()
export const changedLines = (proj: string, id: string) => lines(changedPath(proj, id))

export const readPending = (proj: string, id: string): Record<string, Record<string, string[]>> => JSON.parse(read(pendingPath(proj, id)))
export function writePending(proj: string, id: string, data: unknown): void {
  fs.mkdirSync(stateDir(proj), { recursive: true })
  fs.writeFileSync(pendingPath(proj, id), JSON.stringify(data))
}

type Dict = Record<string, unknown>
export const readTraceRecords = (proj: string, id: string): Dict[] =>
  exists(tracePath(proj, id)) ? lines(tracePath(proj, id)).map((l) => JSON.parse(l) as Dict) : []
export function writeTraceRecords(proj: string, id: string, records: Dict[]): void {
  fs.mkdirSync(stateDir(proj), { recursive: true })
  fs.writeFileSync(tracePath(proj, id), records.map((r) => `${JSON.stringify(r)}\n`).join(''))
}
export const readDeferred = (proj: string, id: string): Dict[] => (exists(deferredPath(proj, id)) ? (JSON.parse(read(deferredPath(proj, id))) as Dict[]) : [])
export function writeDeferred(proj: string, id: string, entries: unknown[]): void {
  fs.mkdirSync(stateDir(proj), { recursive: true })
  fs.writeFileSync(deferredPath(proj, id), JSON.stringify(entries))
}

export function writePolicy(proj: string, rel = '.claude/policies/gate.dw'): string {
  const p = path.join(proj, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'permit (principal, action == Gate::Action::"Run", resource);\n')
  return p
}

/** "x.py" にマッチするルールが consistency_check "chk" を予約する構成を作る。 */
export function setupReservedCheckProject(proj: string, sessionId: string, checkRun: unknown[], extraCheck?: Dict): void {
  const checks: Dict[] = [{ name: 'chk', run: checkRun }]
  if (extraCheck) checks.push(extraCheck)
  writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }], consistency_checks: checks })
  writeChangedFiles(proj, sessionId, 'x.py')
}

// ---- 偽 dogwood ----
// 実 dogwood バイナリに依存させない。DOGWOOD_BIN に下記の偽バイナリを差し、verdict / 異常終了 / 壊れた出力を制御する。
// 実行体はテストを走らせているランタイム（bun / node）自身。
const FAKE_DOGWOOD_SRC = `
const fs = require('node:fs')
const conf = JSON.parse(fs.readFileSync('@CONF@', 'utf8'))
const argv = process.argv.slice(2)
let trace = ''
const ti = argv.indexOf('--trace')
if (ti >= 0) trace = fs.readFileSync(argv[ti + 1], 'utf8')
let prior = []
if (fs.existsSync(conf.calls)) prior = fs.readFileSync(conf.calls, 'utf8').split('\\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
fs.appendFileSync(conf.calls, JSON.stringify({ argv, trace }) + '\\n')
const mode = conf.mode
if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(1) }
if (mode === 'broken') { process.stdout.write('<<not json>>'); process.exit(0) }
if (mode === 'empty') { process.stdout.write(JSON.stringify({ verdicts: [] })); process.exit(0) }
const lastLine = (t) => (t.trim().split('\\n').filter(Boolean).pop() || '')
const last = lastLine(trace)
const flip = conf.deny_after_first_call || []
let verdict
if (flip.some((s) => last.includes(s))) {
  const seenBefore = prior.some((c) => flip.some((s) => lastLine(c.trace).includes(s)))
  verdict = seenBefore ? 'deny' : conf.verdict
} else if (conf.deny.some((s) => last.includes(s))) verdict = 'deny'
else verdict = conf.verdict
process.stdout.write(JSON.stringify({ verdicts: [{ index: 0, verdict }] }))
`

export type FakeDogwoodOpts = { verdict?: string; mode?: 'ok' | 'fail' | 'broken' | 'empty'; deny?: string[]; deny_after_first_call?: string[] }

/** 偽 dogwood を作り [バイナリパス, 呼び出し記録 jsonl のパス] を返す。 */
export function writeFakeDogwood(dir: string, opts: FakeDogwoodOpts = {}): [string, string] {
  fs.mkdirSync(dir, { recursive: true })
  const calls = path.join(dir, 'calls.jsonl')
  const conf = path.join(dir, 'conf.json')
  fs.writeFileSync(conf, JSON.stringify({ verdict: 'allow', mode: 'ok', deny: [], deny_after_first_call: [], ...opts, calls }))
  const bin = path.join(dir, 'dogwood')
  fs.writeFileSync(bin, `#!${process.execPath}\n${FAKE_DOGWOOD_SRC.replace('@CONF@', conf)}`)
  fs.chmodSync(bin, 0o755)
  return [bin, calls]
}

export const readCalls = (calls: string): Array<{ argv: string[]; trace: string }> =>
  exists(calls) ? lines(calls).map((l) => JSON.parse(l) as { argv: string[]; trace: string }) : []
