// /hook-list の画面（webui/hook-list.html）のスクリーンショットを撮る: `bun scripts/ui-screenshots.ts <出力ディレクトリ>`。
//
// tests/fixtures/hook-list/ のサンプル（プロジェクトの gate.yaml と feedback ルール、HOME 側の feedback ルール）を一時ディレクトリに写し、
// Go のバイナリ（FEEDBACK_GATE_BIN、無ければ go build）の `claude hook-list --no-open` で画面を書き出して、Playwright の Chromium で撮る。
// PR ごとに CI（.github/workflows/ui-screenshots.yml）が実行し、撮った画像を PR のコメントに貼る。
//
// 欠けた画面を貼らないよう、撮る前に毎回確かめ、1 つでも当てはまれば撮らずに失敗する:
// JS のエラー（pageerror / console.error）、データが埋め込まれていない（__HOOK_LIST_DATA__ のまま・JSON として読めない）、
// 読み込めていない画像（img の naturalWidth が 0）、横スクロール、描画された行数がデータと合わない、撮れた画像が小さすぎる（真っ白など）。
// 出力: <出力ディレクトリ>/*.png と、それぞれの説明を書いた shots.json（[{ file, title, description }]）。

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const root = path.resolve(import.meta.dir, '..')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'ui-screenshots'))
const fixture = path.join(root, 'tests', 'fixtures', 'hook-list')

/** 撮った画像がこれより小さければ（ほぼ単色）失敗にする。 */
const MIN_PNG_BYTES = 20_000

type Shot = { file: string; title: string; description: string }

function binary(work: string): string {
  const fromEnv = process.env.FEEDBACK_GATE_BIN
  if (fromEnv) return fromEnv
  const out = path.join(work, 'feedback-gate')
  execFileSync('go', ['build', '-o', out, './cmd/feedback-gate'], { cwd: root, stdio: 'inherit' })
  return out
}

/** サンプルを一時ディレクトリに写し、言語 lang の画面を書き出してそのパスを返す。 */
function writePage(bin: string, work: string, lang: 'ja' | 'en'): string {
  const base = path.join(work, lang)
  const project = path.join(base, 'my-project')
  const home = path.join(base, 'home')
  fs.cpSync(path.join(fixture, 'project'), project, { recursive: true })
  fs.cpSync(path.join(fixture, 'home'), home, { recursive: true })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_PROJECT_DIR: project,
    LANG: lang === 'ja' ? 'ja_JP.UTF-8' : 'en_US.UTF-8',
  }
  const r = spawnSync(bin, ['claude', 'hook-list', '--no-open'], { cwd: project, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`hook-list failed (exit ${r.status}):\n${r.stdout}${r.stderr}`)
  const file = r.stdout.trim().split(': ').at(-1) ?? ''
  if (!fs.existsSync(file)) throw new Error(`hook-list did not write the page: ${r.stdout}`)
  return file
}

/** 画面が欠けていないことを確かめる（当てはまれば例外）。 */
async function verify(page: Page, errors: string[], label: string): Promise<void> {
  const state = await page.evaluate(() => {
    const data = document.getElementById('hook-list-data')?.textContent ?? ''
    let rules = -1
    try {
      rules = (JSON.parse(data) as { feedback: { rules: unknown[] } }).feedback.rules.length
    } catch {
      rules = -1
    }
    return {
      placeholder: data.includes('__HOOK_LIST_DATA__'),
      rules,
      rows: document.querySelectorAll('.rrow').length,
      brokenImages: [...document.images].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  const problems: string[] = []
  if (errors.length > 0) problems.push(`JS errors: ${errors.join(' / ')}`)
  if (state.placeholder || state.rules < 0) problems.push('the data is not embedded')
  if (state.rules >= 0 && state.rows !== state.rules) problems.push(`${state.rows} rows rendered for ${state.rules} rules`)
  if (state.brokenImages.length > 0) problems.push(`images not loaded: ${state.brokenImages.join(', ')}`)
  if (state.overflow > 0) problems.push(`horizontal overflow of ${state.overflow}px`)
  if (problems.length > 0) throw new Error(`${label}: ${problems.join('; ')}`)
}

async function capture(
  browser: Browser,
  file: string,
  shot: Shot,
  opts: { width: number; height: number; dark?: boolean; target?: string; prepare?: (page: Page) => Promise<void> },
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light' })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`file://${file}`)
  await page.waitForLoadState('load')
  if (opts.prepare) await opts.prepare(page)
  await verify(page, errors, shot.file)
  const out = path.join(outDir, shot.file)
  if (opts.target) await page.locator(opts.target).screenshot({ path: out })
  else await page.screenshot({ path: out })
  const bytes = fs.statSync(out).size
  if (bytes < MIN_PNG_BYTES) throw new Error(`${shot.file}: the screenshot is only ${bytes} bytes (blank?)`)
  await page.close()
  console.log(`wrote ${path.relative(process.cwd(), out)} (${Math.round(bytes / 1024)} KiB)`)
}

const shots: Array<[Shot, 'ja' | 'en', Parameters<typeof capture>[3]]> = [
  [{ file: '1-overview.png', title: '全体（先頭）', description: '件数のまとめと、gate.yaml の rules。' }, 'ja', { width: 1200, height: 900 }],
  [
    { file: '2-gate.png', title: 'gate.yaml', description: 'rules / consistency_checks / session_start と、それぞれが動くタイミング。' },
    'ja',
    { width: 1200, height: 900, target: '#gate' },
  ],
  [
    { file: '3-feedback.png', title: 'feedback ルールの一覧', description: '1 ルール 1 行。段階・置き場所・イベントで絞り込める。' },
    'ja',
    { width: 1200, height: 900, target: '#feedback' },
  ],
  [
    {
      file: '4-feedback-filtered.png',
      title: '絞り込みと詳細',
      description: '「deny」で絞り込み、1 行を開いた状態（enforce の when / check / message）。',
    },
    'ja',
    {
      width: 1200,
      height: 900,
      target: '#feedback',
      prepare: async (page) => {
        await page.click('.fbar >> text=deny')
        await page.click('.rrow:not(.hidden) >> nth=0 >> summary')
      },
    },
  ],
  [
    { file: '5-dark.png', title: 'ダークテーマ', description: 'OS の設定がダークのとき。' },
    'ja',
    { width: 1200, height: 900, dark: true, target: '#feedback' },
  ],
  [
    { file: '6-mobile.png', title: 'スマホ幅（390px）', description: '表は 1 行を折り返して表示する。' },
    'ja',
    { width: 390, height: 844, prepare: async (page) => page.evaluate(() => document.getElementById('feedback')?.scrollIntoView()) },
  ],
  [{ file: '7-english.png', title: '英語', description: 'language が en のとき。' }, 'en', { width: 1200, height: 900, target: '#feedback' }],
]

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-list-shots-'))
try {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const bin = binary(work)
  const pages = { ja: writePage(bin, work, 'ja'), en: writePage(bin, work, 'en') }
  const browser = await chromium.launch()
  try {
    for (const [shot, lang, opts] of shots) await capture(browser, pages[lang], shot, opts)
  } finally {
    await browser.close()
  }
  fs.writeFileSync(
    path.join(outDir, 'shots.json'),
    `${JSON.stringify(
      shots.map(([shot]) => shot),
      null,
      2,
    )}\n`,
  )
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
