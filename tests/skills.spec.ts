// 同梱スキル（skills/<name>/SKILL.md）の体裁を確かめる。Claude Code はプラグイン直下の skills/ を自動検出し、
// frontmatter の name / description で /feedback-gate:<name> として登録するので、ディレクトリ名と name の一致、
// description の有無、本文から参照する補助ファイルの存在、SKILL.md の長さ（公式の推奨は 500 行未満）を見る。
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseYaml } from '../src/load-yaml.ts'
import { REPO_ROOT } from './helpers/node-io.ts'

const SKILLS_DIR = path.join(REPO_ROOT, 'skills')
const FRONTMATTER_RE = /^---\n([\s\S]*?\n)---\n/
const LINK_RE = /\]\(([^)#?\s]+)(?:#[^)]*)?\)/g

const skillDirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

describe('skills/', () => {
  test('feedback と gate の 2 つを同梱する', () => {
    expect(skillDirs).toEqual(['feedback', 'gate'])
  })

  for (const dir of skillDirs) {
    const skillDir = path.join(SKILLS_DIR, dir)
    const skillFile = path.join(skillDir, 'SKILL.md')

    test(`${dir}: SKILL.md の frontmatter は name がディレクトリ名と一致し、description を持つ`, () => {
      const text = fs.readFileSync(skillFile, 'utf8')
      const m = FRONTMATTER_RE.exec(text)
      expect(m).not.toBeNull()
      const fm = parseYaml(m?.[1] ?? '') as Record<string, unknown>
      expect(fm.name).toBe(dir)
      expect(typeof fm.description).toBe('string')
      const description = String(fm.description)
      expect(description.length).toBeGreaterThan(40)
      // description は when_to_use と合わせて 1,536 文字まで（Claude Code の上限）
      expect(description.length).toBeLessThanOrEqual(1536)
      expect(typeof fm['argument-hint']).toBe('string')
      // Claude Code 以外の環境で拒否されるキーや、予約語の名前を使っていないこと
      expect(String(fm.name).startsWith('anthropic-skills')).toBe(false)
    })

    test(`${dir}: SKILL.md は 500 行未満で、本文の冒頭に見出しがある`, () => {
      const text = fs.readFileSync(skillFile, 'utf8')
      expect(text.split('\n').length).toBeLessThan(500)
      const body = text.replace(FRONTMATTER_RE, '')
      expect(body.trimStart().startsWith('# ')).toBe(true)
    })

    test(`${dir}: Markdown から相対参照する補助ファイルがすべて存在する`, () => {
      const files = fs.readdirSync(skillDir).filter((f) => f.endsWith('.md'))
      expect(files).toContain('SKILL.md')
      for (const f of files) {
        const text = fs.readFileSync(path.join(skillDir, f), 'utf8')
        for (const m of text.matchAll(LINK_RE)) {
          const target = m[1] ?? ''
          if (/^[a-z]+:/.test(target)) continue // URL
          expect(fs.existsSync(path.join(skillDir, target))).toBe(true)
        }
      }
    })

    test(`${dir}: SKILL.md が置換される変数は $ARGUMENTS と \${CLAUDE_PLUGIN_ROOT} 以外に使わない`, () => {
      // Claude Code は読み込み時に $ARGUMENTS・$N・${CLAUDE_*} を置換する。$0 のような位置引数や
      // 未知の ${...} を誤って書くと本文が欠けるので、意図したもの以外が無いことを確かめる。
      const text = fs.readFileSync(skillFile, 'utf8')
      const vars = [...text.matchAll(/\$\{[A-Za-z_]+\}|\$[A-Z_]+|\$\d+/g)].map((m) => m[0])
      const allowed = new Set(['$ARGUMENTS', `\${CLAUDE_PLUGIN_ROOT}`, '$CLAUDE_GATE_FILES', '$CLAUDE_PROJECT_DIR'])
      expect(vars.filter((v) => !allowed.has(v))).toEqual([])
    })
  }
})
