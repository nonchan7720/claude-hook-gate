import { describe, expect, test } from 'bun:test'
import { LANGS, langOfLocale, resolveLang, resources, tr } from '../src/i18n.ts'

describe('langOfLocale', () => {
  test('ja で始まるロケールは ja、それ以外は en、空は undefined', () => {
    expect(langOfLocale('ja_JP.UTF-8')).toBe('ja')
    expect(langOfLocale('ja')).toBe('ja')
    expect(langOfLocale('JA_JP')).toBe('ja')
    expect(langOfLocale('en_US.UTF-8')).toBe('en')
    expect(langOfLocale('C')).toBe('en')
    expect(langOfLocale('POSIX')).toBe('en')
    expect(langOfLocale('de_DE')).toBe('en')
    // ja の後に英字が続くものは別の言語（jav = Javanese）
    expect(langOfLocale('jav_ID')).toBe('en')
    expect(langOfLocale('')).toBeUndefined()
    expect(langOfLocale('  ')).toBeUndefined()
    expect(langOfLocale(undefined)).toBeUndefined()
  })
})

describe('resolveLang', () => {
  test('プラグイン設定の ja / en が最優先', () => {
    expect(resolveLang({ LANG: 'en_US.UTF-8' }, 'ja')).toBe('ja')
    expect(resolveLang({ LANG: 'ja_JP.UTF-8', FEEDBACK_GATE_LANG: 'ja' }, 'en')).toBe('en')
  })

  test('auto / 未設定 / 不正値は環境変数から決める', () => {
    expect(resolveLang({ LANG: 'ja_JP.UTF-8' }, 'auto')).toBe('ja')
    expect(resolveLang({ LANG: 'ja_JP.UTF-8' }, undefined)).toBe('ja')
    expect(resolveLang({ LANG: 'ja_JP.UTF-8' }, 'fr')).toBe('ja')
    expect(resolveLang({ LANG: 'ja_JP.UTF-8' }, 42)).toBe('ja')
    expect(resolveLang({ LANG: 'en_US.UTF-8' }, 'auto')).toBe('en')
  })

  test('環境変数は FEEDBACK_GATE_LANG → LC_ALL → LC_MESSAGES → LANG の順に最初の値を使う', () => {
    expect(resolveLang({ FEEDBACK_GATE_LANG: 'en', LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang({ FEEDBACK_GATE_LANG: 'ja', LC_ALL: 'C', LANG: 'C' })).toBe('ja')
    expect(resolveLang({ LC_ALL: 'C', LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang({ LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'C' })).toBe('ja')
    expect(resolveLang({ LC_ALL: '', LC_MESSAGES: '', LANG: 'ja_JP.UTF-8' })).toBe('ja')
  })

  test('どれにも値が無ければ en', () => {
    expect(resolveLang({})).toBe('en')
    expect(resolveLang({ HOME: '/h', LANG: '' })).toBe('en')
  })
})

/** ネストしたカタログを 'a.b.c' 形式のキーの一覧にする。 */
function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null) out.push(...flatKeys(v as Record<string, unknown>, key))
    else out.push(key)
  }
  return out.sort()
}

/** 文面に含まれる補間変数（{{name}}）の集合。 */
const placeholders = (text: unknown): string[] => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort()

const lookup = (obj: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj)

describe('locales/*.yaml', () => {
  test('ja と en は同じキーを持つ', () => {
    expect(LANGS).toEqual(['ja', 'en'])
    expect(flatKeys(resources.en)).toEqual(flatKeys(resources.ja))
    expect(flatKeys(resources.ja).length).toBeGreaterThan(50)
  })

  test('同じキーの文面は同じ補間変数を使う', () => {
    for (const key of flatKeys(resources.ja)) {
      expect({ key, vars: placeholders(lookup(resources.en, key)) }).toEqual({ key, vars: placeholders(lookup(resources.ja, key)) })
    }
  })

  test('すべての値は文字列', () => {
    for (const lang of LANGS) for (const key of flatKeys(resources[lang])) expect(typeof lookup(resources[lang], key)).toBe('string')
  })
})

describe('tr', () => {
  test('lang に応じた文面を補間付きで引く', () => {
    expect(tr('ja')('gate.timeout', { seconds: 30 })).toBe('[gate] タイムアウト（30秒）で強制終了しました。無限ループやハングの可能性があります。')
    expect(tr('en')('gate.timeout', { seconds: 30 })).toBe('[gate] Killed after the timeout (30s). The command may be in an infinite loop or hung.')
    expect(tr('en')('band.running')).toBe('[gate] running:')
  })

  test('補間値は HTML エスケープされず、値の中の {{ }} も展開されない', () => {
    expect(tr('en')('gate.cannotReadYaml', { path: '/a/b "c" <d> & {{x}}' })).toBe('cannot read gate.yaml: /a/b "c" <d> & {{x}}')
  })

  test('無いキーはキーそのものを返す（文面が消えないように）', () => {
    expect(tr('ja')('no.such.key')).toBe('no.such.key')
  })
})
