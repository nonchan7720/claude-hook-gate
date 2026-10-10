// hook が出すメッセージ（feedback の指示文・gate の結果・通知・/correct の報告）の言語と翻訳。
//
// 言語の決め方は、プラグイン設定（userConfig の `language`）が `ja` / `en` ならそれ。`auto`（既定）か未設定なら
// OS の言語設定を環境変数から読む: FEEDBACK_GATE_LANG（このプラグイン専用の上書き）→ LC_ALL → LC_MESSAGES → LANG の
// 順に、最初に値のあるものを使い、`ja` で始まれば日本語、それ以外（`C` / `POSIX` / 未設定を含む）は英語。
//
// 文面は locales/<lang>.yaml にあり（バンドル時に文字列として取り込む）、i18next で引く。各モジュールは
// `tr(io.lang)` で得た翻訳関数にキー（例: 'gate.timeout'）と補間値（{{seconds}}）を渡す。
import i18next, { type TFunction } from 'i18next'
import { parse } from 'yaml'
import enYaml from '../locales/en.yaml' with { type: 'text' }
import jaYaml from '../locales/ja.yaml' with { type: 'text' }
import type { EnvVars } from './io.ts'

export type Lang = 'ja' | 'en'
export const LANGS: readonly Lang[] = ['ja', 'en']

export type Translate = TFunction

/** 言語ごとの文面（locales/*.yaml を読んだもの）。キーの一致はテストで検査する。 */
export const resources: Record<Lang, Record<string, unknown>> = {
  ja: parse(jaYaml) as Record<string, unknown>,
  en: parse(enYaml) as Record<string, unknown>,
}

const i18n = i18next.createInstance()
// initAsync: false で同期に初期化する（リソースは同梱なので読み込み待ちが無い）。
// escapeValue: false は、補間値（コマンド文字列やパス）を HTML エスケープしないため。
i18n.init({
  resources: { ja: { translation: resources.ja }, en: { translation: resources.en } },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: LANGS,
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
})

/** lang で引く翻訳関数を返す。 */
export const tr = (lang: Lang): Translate => i18n.getFixedT(lang)

const isLang = (v: unknown): v is Lang => v === 'ja' || v === 'en'

/** ロケール文字列（`ja_JP.UTF-8` / `ja` / `en_US` / `C`）から言語を決める。空なら undefined。 */
export function langOfLocale(locale: string | undefined): Lang | undefined {
  const v = (locale ?? '').trim()
  if (v === '') return undefined
  return /^ja(?![a-z])/i.test(v) ? 'ja' : 'en'
}

/**
 * 言語を決める。configured（プラグイン設定の `language`）が ja / en ならそれ、それ以外（auto / 未設定 / 不正値）なら
 * 環境変数から。どれにも値が無ければ英語。
 */
export function resolveLang(env: Readonly<EnvVars>, configured?: unknown): Lang {
  if (isLang(configured)) return configured
  if (isLang(env.FEEDBACK_GATE_LANG)) return env.FEEDBACK_GATE_LANG
  for (const v of [env.FEEDBACK_GATE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const lang = langOfLocale(v)
    if (lang) return lang
  }
  return 'en'
}
