// /hook-list（src/hook-list.ts）は scripts/hook-list.sh 経由で Go の `feedback-gate claude hook-list` を呼ぶだけなので、
// ここでは実際のバイナリを走らせ、書き出された HTML に埋め込まれたデータ（webui/hook-list.html の hook-list-data）を確かめる。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { hookListCommand, optionEnv } from '../src/hook-list.ts'
import { feedbackGateBin } from './helpers/go-binary.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

// このファイルの間だけ、手元でビルドしたバイナリを使う（scripts/hook-list.sh は子プロセスで process.env を継ぐ）。
let savedBin: string | undefined
beforeAll(() => {
  savedBin = process.env.FEEDBACK_GATE_BIN
  process.env.FEEDBACK_GATE_BIN = feedbackGateBin()
})
afterAll(() => {
  if (savedBin === undefined) delete process.env.FEEDBACK_GATE_BIN
  else process.env.FEEDBACK_GATE_BIN = savedBin
})

type Model = {
  project: string
  lang: string
  labels: Record<string, string>
  gate: { path: string | null; rules: Array<{ match: string[]; run: unknown[]; runChecks: string[] }>; checks: Array<{ name: string; referenced: boolean }> }
  feedback: {
    rules: Array<{
      name: string
      scope: string
      level: string
      inject: { kind: string }
      enforce: Array<{ event: string; severity: string; fields: string[][] }>
    }>
    inactive: Array<{ name: string; reason: string }>
    broken: unknown[]
  }
  options: { agentLaunchGuard: boolean; autoCount: boolean; language: string }
}

const embedded = (html: string): Model => {
  const m = /<script id="hook-list-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!m?.[1]) throw new Error('no hook-list-data in the page')
  return JSON.parse(m[1]) as Model
}

const writeRule = (dir: string, name: string, front: string) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d ${name}\ntype: feedback\n${front}---\n\nbody\n`)
}

const withProject = async (body: (proj: string, feedback: string, home: string) => Promise<void>) => {
  const dirs = [tmpDir(), tmpDir(), tmpDir()] as const
  try {
    await body(...dirs)
  } finally {
    for (const d of dirs) rmTree(d)
  }
}

describe('optionEnv', () => {
  test('passes the plugin settings as CLAUDE_PLUGIN_OPTION_*', () => {
    expect(optionEnv({ language: 'en', agentLaunchGuard: true, autoCount: false, other: 1 })).toEqual({
      CLAUDE_PLUGIN_OPTION_language: 'en',
      CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'true',
      CLAUDE_PLUGIN_OPTION_autoCount: 'false',
    })
  })
})

describe('hookListCommand', () => {
  test('writes the page with gate.yaml and the feedback rules and reports its path', () =>
    withProject(async (proj, feedback, home) => {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
      fs.writeFileSync(
        path.join(proj, '.claude', 'gate.yaml'),
        'rules:\n  - match: "**/*.py"\n    run: [ruff check, {parallel: [{name: t, cmd: pytest}]}]\n    run_checks: [all]\nconsistency_checks:\n  - {name: all, run: [make]}\n  - {name: orphan, run: [x]}\n',
      )
      writeRule(feedback, 'no_force', "count: 5\nenforce:\n  - event: pre_bash\n    when: 'push --force'\n")
      writeRule(path.join(proj, '.claude', 'feedback'), 'py_rule', "count: 3\nfiles: ['**/*.py']\n")
      writeRule(feedback, 'old', 'count: 3\nexpires: 2020-01-01\n')
      const io = makeIo({ projectDir: proj, env: { HOME: home, CLAUDE_FEEDBACK_DIR: feedback, LANG: 'en_US.UTF-8' } })
      const r = await hookListCommand(io, '--no-open', { agentLaunchGuard: true })
      expect(r.context).toEqual([])
      const prefix = '[hook-list] Wrote the list. Open it in a browser: '
      expect(r.text.startsWith(prefix)).toBe(true)
      const file = r.text.slice(prefix.length)
      // <プロジェクトのパスを読める形にしたもの>-<パス全体のハッシュ 10 桁>.html
      expect(path.dirname(file)).toBe(path.join(home, '.claude', 'feedback-gate', 'hook-list'))
      expect(path.basename(file)).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{10}\.html$/)
      const model = embedded(fs.readFileSync(file, 'utf8'))
      expect(model.project).toBe(proj)
      expect(model.lang).toBe('en')
      expect(model.labels['event.pre_bash']).toBe('checks the command before Bash runs')
      expect(model.gate.path).toBe(path.join(proj, '.claude', 'gate.yaml'))
      expect(model.gate.rules).toEqual([
        {
          match: ['**/*.py'],
          options: [],
          run: [{ cmd: 'ruff check' }, { parallel: [{ cmd: 'pytest', name: 't' }] }],
          runChecks: ['all'],
        } as never,
      ])
      expect(model.gate.checks.map((c) => [c.name, c.referenced])).toEqual([
        ['all', true],
        ['orphan', false],
      ])
      expect(model.feedback.rules.map((x) => [x.name, x.scope, x.level, x.inject.kind])).toEqual([
        ['no_force', 'global', 'deny', 'prompt'],
        ['py_rule', 'project', 'confirmed', 'files'],
      ])
      expect(model.feedback.rules[0]?.enforce).toEqual([{ event: 'pre_bash', severity: 'deny', fields: [['when', 'push --force']] }])
      expect(model.feedback.inactive).toEqual([{ name: 'old', reason: 'expires (2020-01-01) has passed', path: path.join(feedback, 'old.md') } as never])
      expect(model.options).toEqual({ agentLaunchGuard: true, autoCount: true, language: 'en' })
    }))

  test('follows the language setting', () =>
    withProject(async (proj, feedback, home) => {
      const io = makeIo({ projectDir: proj, env: { HOME: home, CLAUDE_FEEDBACK_DIR: feedback, LANG: 'en_US.UTF-8' } })
      const r = await hookListCommand(io, '--no-open', { language: 'ja' })
      expect(r.text.startsWith('[hook-list] 一覧を書き出しました。')).toBe(true)
    }))

  test('reports a failure of the script', () =>
    withProject(async (proj, feedback, home) => {
      const io = makeIo({ projectDir: proj, pluginRoot: proj, env: { HOME: home, CLAUDE_FEEDBACK_DIR: feedback } })
      const r = await hookListCommand(io, '--no-open')
      expect(r.text.startsWith('[hook-list] failed (exit 127)')).toBe(true)
    }))
})
