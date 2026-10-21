// settings hook の CLI 用の Io（src/node-io.ts）: run() がコマンドの終了で返り、hook のプロセスを掴んだままにしないこと。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { makeNodeIo } from '../src/node-io.ts'
import { REPO_ROOT, TEST_HOME } from './helpers/node-io.ts'

const io = makeNodeIo({ env: { ...process.env, HOME: TEST_HOME }, payloadCwd: REPO_ROOT })

describe('node-io run()', () => {
  test('returns the exit code and output', async () => {
    const r = await io.run(['sh', '-c', 'echo out; echo err >&2; exit 3'])
    expect(r).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
  })

  test('returns when the command exits even if a background grandchild still holds stdout/stderr', async () => {
    // sleep は stdout / stderr のパイプを継いだままバックグラウンドに残る（dev サーバーやデーモンと同じ形）。
    // 'close' 待ちだと sleep が終わるまで返らないが、'exit' を基準にするのでコマンドの終了のすぐ後に返る。
    const started = Date.now()
    const r = await io.run(['sh', '-c', 'sleep 20 & echo done'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('done\n')
    expect(r.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('the timeout kills the process group and reports timedOut', async () => {
    const started = Date.now()
    const r = await io.run(['sh', '-c', 'sleep 20; echo late'], { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBe(1)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('the CLI process exits right after the hook even when a gate command leaves a grandchild behind', () => {
    // src/cli.ts を bun で子プロセスとして走らせ、run() の中身（sleep を残す sh）を経て CLI 自身が終わることを確かめる。
    const script = `
      import { makeNodeIo } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'node-io.ts'))}
      const io = makeNodeIo({ env: process.env })
      const r = await io.run(['sh', '-c', 'sleep 20 & echo hi'])
      process.stdout.write(r.stdout)
    `
    const started = Date.now()
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: TEST_HOME } })
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('hi\n')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
