// hook が出すメッセージ（feedback の指示文・gate の結果・通知・/correct の報告）の言語。
//
// 決め方は、プラグイン設定（userConfig の `language`）が `ja` / `en` ならそれ。`auto`（既定）か未設定なら
// OS の言語設定を環境変数から読む: FEEDBACK_GATE_LANG（このプラグイン専用の上書き）→ LC_ALL → LC_MESSAGES → LANG の
// 順に、最初に値のあるものを使い、`ja` で始まれば日本語、それ以外（`C` / `POSIX` / 未設定を含む）は英語。
//
// 翻訳そのものは messages.ts にあり、各モジュールは `tr(io.lang)` で引いた関数にメッセージと引数を渡す。
import type { EnvVars } from './io.ts'

export type Lang = 'ja' | 'en'

/** 1 つのメッセージの日本語版と英語版。引数の型は両方で同じ。 */
export type Msg<A extends unknown[]> = { readonly ja: (...a: A) => string; readonly en: (...a: A) => string }

/** メッセージを定義する。ja と en の引数が一致しないとコンパイルで落ちる。 */
export const msg = <A extends unknown[]>(ja: (...a: A) => string, en: (...a: A) => string): Msg<A> => ({ ja, en })

export type Translate = <A extends unknown[]>(m: Msg<A>, ...a: A) => string

/** lang で引く翻訳関数を返す。 */
export const tr =
  (lang: Lang): Translate =>
  (m, ...a) =>
    m[lang](...a)

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
