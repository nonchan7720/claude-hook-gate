// UserPromptSubmit で毎回注入するルールファイルの読み込み。
import type { Lang } from './i18n.ts'
import type { Io } from './io.ts'
import { join } from './path.ts'

export const DEFAULT_RULES_FILE = '~/.claude/feedback-gate/feedback_rules.md'

/** プラグイン同梱のルールファイル名。英語のときは feedback_rules.en.md。 */
export const bundledRulesName = (lang: Lang): string => (lang === 'en' ? 'feedback_rules.en.md' : 'feedback_rules.md')

/**
 * rulesFile（先頭の ~ は HOME に展開）があればその内容、無ければプラグイン同梱の rules/feedback_rules.md
 * （英語なら rules/feedback_rules.en.md）の内容。どちらも無ければ空文字。
 */
export async function loadRules(io: Io, rulesFile: unknown): Promise<string> {
  const home = io.env.HOME
  const configured = typeof rulesFile === 'string' && rulesFile !== '' ? rulesFile : DEFAULT_RULES_FILE
  const custom = configured.startsWith('~') ? (home ? `${home}${configured.slice(1)}` : undefined) : configured
  const bundled = join(io.pluginRoot, 'rules', bundledRulesName(io.lang))
  for (const path of [custom, bundled]) {
    if (path && (await io.exists(path))) return ((await io.readFile(path)) ?? '').trim()
  }
  return ''
}
