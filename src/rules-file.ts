// UserPromptSubmit で毎回注入するルールファイルの読み込み。
import { configPaths } from './config-dir.ts'
import type { Lang } from './i18n.ts'
import type { Io } from './io.ts'
import { join } from './path.ts'

/** rulesFile 未設定のときに探す場所: ~/<設定ディレクトリ>/feedback-gate/feedback_rules.md。 */
export const DEFAULT_RULES_FILE = '~/{.claude,.agents}/feedback-gate/feedback_rules.md'

/** プラグイン同梱のルールファイル名。英語のときは feedback_rules.en.md。 */
export const bundledRulesName = (lang: Lang): string => (lang === 'en' ? 'feedback_rules.en.md' : 'feedback_rules.md')

/**
 * rulesFile（先頭の ~ は HOME に展開）があればその内容、無ければプラグイン同梱の rules/feedback_rules.md
 * （英語なら rules/feedback_rules.en.md）の内容。どちらも無ければ空文字。
 */
export async function loadRules(io: Io, rulesFile: unknown): Promise<string> {
  const home = io.env.HOME
  const expand = (p: string): string | undefined => (p.startsWith('~') ? (home ? `${home}${p.slice(1)}` : undefined) : p)
  const configured =
    typeof rulesFile === 'string' && rulesFile !== '' ? [expand(rulesFile)] : home ? configPaths(io, home, 'feedback-gate', 'feedback_rules.md') : []
  const bundled = join(io.pluginRoot, 'rules', bundledRulesName(io.lang))
  for (const path of [...configured, bundled]) {
    if (path && (await io.exists(path))) return ((await io.readFile(path)) ?? '').trim()
  }
  return ''
}
