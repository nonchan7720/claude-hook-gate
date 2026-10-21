// 設定ディレクトリの候補（.claude / .agents）: どちらにあっても読め、状態ファイルは 1 か所に置き、シンボリックリンクで同じ実体を指しても二重に読まない。
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_CONFIG_DIRS, configPaths, findGateYaml, pickConfigDir } from '../src/config-dir.ts'
import { feedbackDir, feedbackDirs, listRules, projectFeedbackDir, projectFeedbackDirs } from '../src/feedback-rules.ts'
import { loadRules } from '../src/rules-file.ts'
import { gateStatusDir } from '../src/running-registry.ts'
import { stopTestGate } from '../src/stop-test-gate.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const writeRule = (dir: string, name: string, count: number) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\ntype: feedback\ncount: ${count}\n---\n\n${name}\n`)
}

async function withDirs<T>(body: (proj: string, home: string) => Promise<T>): Promise<T> {
  const proj = tmpDir()
  const home = tmpDir()
  try {
    return await body(proj, home)
  } finally {
    rmTree(proj)
    rmTree(home)
  }
}

describe('pickConfigDir / configPaths', () => {
  test('the first existing candidate wins; with none, the first candidate', () =>
    withDirs(async (proj) => {
      const exists = async (p: string) => fs.existsSync(p)
      expect(await pickConfigDir(CLAUDE_CONFIG_DIRS, proj, exists)).toBe(path.join(proj, '.claude'))
      fs.mkdirSync(path.join(proj, '.agents'))
      expect(await pickConfigDir(CLAUDE_CONFIG_DIRS, proj, exists)).toBe(path.join(proj, '.agents'))
      fs.mkdirSync(path.join(proj, '.claude'))
      expect(await pickConfigDir(CLAUDE_CONFIG_DIRS, proj, exists)).toBe(path.join(proj, '.claude'))
      expect(configPaths(makeIo({ projectDir: proj }), proj, 'gate.yaml')).toEqual([
        path.join(proj, '.claude', 'gate.yaml'),
        path.join(proj, '.agents', 'gate.yaml'),
      ])
    }))
})

describe('gate.yaml and the state directory', () => {
  test('Claude Code finds .agents/gate.yaml when .claude has none, and keeps the state next to it', () =>
    withDirs(async (proj) => {
      fs.mkdirSync(path.join(proj, '.agents'))
      fs.writeFileSync(path.join(proj, '.agents', 'gate.yaml'), '{"rules":[]}')
      const io = makeIo({ projectDir: proj })
      expect(await findGateYaml(io)).toBe(path.join(proj, '.agents', 'gate.yaml'))
      expect(gateStatusDir(io)).toBe(path.join(proj, '.agents', '.gate-status'))
    }))

  test('Claude Code prefers .claude over .agents when both have a gate.yaml', () =>
    withDirs(async (proj) => {
      for (const d of ['.agents', '.claude']) {
        fs.mkdirSync(path.join(proj, d))
        fs.writeFileSync(path.join(proj, d, 'gate.yaml'), '{"rules":[]}')
      }
      expect(await findGateYaml(makeIo({ projectDir: proj }))).toBe(path.join(proj, '.claude', 'gate.yaml'))
    }))

  test('the gate.yml typo is reported with the path it was found at, in either directory', () =>
    withDirs(async (proj) => {
      fs.mkdirSync(path.join(proj, '.agents'))
      fs.writeFileSync(path.join(proj, '.agents', 'gate.yml'), '{"rules":[]}')
      const r = await stopTestGate(makeIo({ projectDir: proj }), 'rules', { session_id: 's' })
      expect(r.stdout).toContain(path.join(proj, '.agents', 'gate.yml'))
    }))
})

describe('feedback rules in .claude and .agents', () => {
  test('rules from ~/.agents/feedback and <project>/.agents/feedback are read too; the state stays in one directory', () =>
    withDirs(async (proj, home) => {
      writeRule(path.join(home, '.claude', 'feedback'), 'global_claude', 3)
      writeRule(path.join(home, '.agents', 'feedback'), 'global_agents', 3)
      writeRule(path.join(proj, '.agents', 'feedback'), 'project_agents', 3)
      const io = makeIo({ projectDir: proj, env: { HOME: home } })
      expect(feedbackDirs(io)).toEqual([path.join(home, '.claude', 'feedback'), path.join(home, '.agents', 'feedback')])
      expect(projectFeedbackDirs(io)).toEqual([path.join(proj, '.claude', 'feedback'), path.join(proj, '.agents', 'feedback')])
      expect(feedbackDir(io)).toBe(path.join(home, '.claude', 'feedback'))
      expect(projectFeedbackDir(io)).toBe(path.join(proj, '.agents', 'feedback'))
      expect((await listRules(io)).map((r) => r.name).sort()).toEqual(['global_agents', 'global_claude', 'project_agents'])
    }))

  test('when .agents is a symlink to .claude, each rule is read once (the first candidate wins)', () =>
    withDirs(async (proj, home) => {
      writeRule(path.join(home, '.claude', 'feedback'), 'shared', 3)
      fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.agents'))
      writeRule(path.join(proj, '.agents', 'feedback'), 'proj_rule', 4)
      fs.symlinkSync(path.join(proj, '.agents'), path.join(proj, '.claude'))
      const rules = await listRules(makeIo({ projectDir: proj, env: { HOME: home }, configDirNames: CLAUDE_CONFIG_DIRS }))
      expect(rules.map((r) => [r.name, r.count])).toEqual([
        ['shared', 3],
        ['proj_rule', 4],
      ])
    }))

  test('CLAUDE_FEEDBACK_DIR replaces the home candidates entirely', () =>
    withDirs(async (proj, home) => {
      const io = makeIo({ projectDir: proj, env: { HOME: home, CLAUDE_FEEDBACK_DIR: '/override' } })
      expect(feedbackDirs(io)).toEqual(['/override'])
      expect(feedbackDir(io)).toBe('/override')
    }))

  test('the default rules file is looked up in ~/.claude and ~/.agents', () =>
    withDirs(async (proj, home) => {
      fs.mkdirSync(path.join(home, '.agents', 'feedback-gate'), { recursive: true })
      fs.writeFileSync(path.join(home, '.agents', 'feedback-gate', 'feedback_rules.md'), 'AGENTS RULES\n')
      expect(await loadRules(makeIo({ projectDir: proj, env: { HOME: home } }), undefined)).toBe('AGENTS RULES')
    }))
})
