import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ProcessSpawnChunk } from 'claude-code'
import { classicPayload, collect, EVENT_LINE_PREFIX, optionEnv } from '../src/go-bridge.ts'
import { writeGateYaml } from './helpers/gate.ts'
import { feedbackGateBin } from './helpers/go-binary.ts'
import { REPO_ROOT, withTmp } from './helpers/node-io.ts'

async function* chunks(...list: ProcessSpawnChunk[]): AsyncGenerator<ProcessSpawnChunk> {
  for (const c of list) yield c
}

const screen = () => {
  const statuses: Array<string | undefined> = []
  let redraws = 0
  return { statuses, redraws: () => redraws, screen: { status: (t: string | undefined) => void statuses.push(t), redraw: () => void redraws++ } }
}

describe('collect', () => {
  test('event lines go to the screen in order and are taken out of stderr, even when split across chunks', async () => {
    const s = screen()
    const out = await collect(
      chunks(
        { stream: 'stderr', text: `warn 1\n${EVENT_LINE_PREFIX}{"progress":"評価` },
        { stream: 'stdout', text: '{"a":' },
        { stream: 'stderr', text: `中"}\n${EVENT_LINE_PREFIX}{"redraw":true}\n` },
        { stream: 'stdout', text: '1}\n' },
        { stream: 'stderr', text: `${EVENT_LINE_PREFIX}{"result":""}\nlast` },
      ),
      s.screen,
    )
    expect(out).toEqual({ stdout: '{"a":1}\n', stderr: 'warn 1\nlast' })
    expect(s.statuses).toEqual(['評価中', undefined])
    expect(s.redraws()).toBe(1)
  })

  test('a broken event line is dropped without touching the screen', async () => {
    const s = screen()
    const out = await collect(chunks({ stream: 'stderr', text: `${EVENT_LINE_PREFIX}{oops\n` }), s.screen)
    expect(out.stderr).toBe('')
    expect(s.statuses).toEqual([])
  })
})

test('optionEnv passes the plugin options as CLAUDE_PLUGIN_OPTION_<key>', () => {
  expect(optionEnv({ language: 'en', autoCount: false, agentLaunchGuard: true, nested: { a: 1 } })).toEqual({
    CLAUDE_PLUGIN_OPTION_language: 'en',
    CLAUDE_PLUGIN_OPTION_autoCount: 'false',
    CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'true',
  })
})

test('classicPayload fills session_id / cwd / hook_event_name only when missing', () => {
  expect(classicPayload('Stop', { session_id: 'mine' }, 's', '/p')).toEqual({ session_id: 'mine', cwd: '/p', hook_event_name: 'Stop' })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

// ESC: エンジンは hook を中断すると、spawn したプロセスに SIGTERM を送る。hook.sh は exec で Go に置き換わり、Go は
// SIGTERM を受けると走っている gate のコマンドのプロセスグループを SIGKILL してから終わる。
test.skipIf(process.platform === 'win32')(
  'SIGTERM to the spawned hook also kills the gate command it is running',
  () =>
    withTmp(async (proj) => {
      const pidFile = path.join(proj, 'gate.pid')
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: `echo $$ > ${pidFile}; exec sleep 30`, name: 'slow', timeout: 60 }] }] })
      const child = spawn('bash', [path.join(REPO_ROOT, 'scripts', 'hook.sh'), 'PostToolUse'], {
        cwd: proj,
        env: {
          ...process.env,
          HOME: proj,
          CLAUDE_FEEDBACK_DIR: path.join(proj, 'fb'),
          CLAUDE_PROJECT_DIR: proj,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
          FEEDBACK_GATE_BIN: feedbackGateBin(),
          FEEDBACK_GATE_FROM_MOD: '1',
          FEEDBACK_GATE_EVENTS: 'stderr',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      const closed = new Promise<void>((r) => child.on('close', () => r()))
      child.stdin.end(JSON.stringify({ session_id: 'sess-esc', cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, 'x.py') } }))
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 15_000)).toBe(true)
      const gatePid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      expect(alive(gatePid)).toBe(true)
      child.kill('SIGTERM')
      await closed
      expect(await waitFor(() => !alive(gatePid), 5_000)).toBe(true)
    }),
  30_000,
)
