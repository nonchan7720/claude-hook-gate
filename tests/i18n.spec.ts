import { describe, expect, test } from 'bun:test'
import { langOfLocale, msg, resolveLang, tr } from '../src/i18n.ts'

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

describe('msg / tr', () => {
  test('lang に応じた版を引数付きで引く', () => {
    const m = msg(
      (n: number) => `${n} 件`,
      (n: number) => `${n} items`,
    )
    expect(tr('ja')(m, 3)).toBe('3 件')
    expect(tr('en')(m, 3)).toBe('3 items')
  })
})
