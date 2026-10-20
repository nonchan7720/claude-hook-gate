// フックモジュールを配布用の ESM（hooks/register.js と hooks/vendor/*.js）にまとめる。
//
// mod の実行環境（Claude Code が直接 ES モジュールとして読む）はプラグイン内の相対 import と
// `claude-code` しか解決できないので、`yaml` などの依存はここでバンドルして取り込む。
// 依存のライブラリ（yaml / i18next）は hooks/vendor/ に 1 ライブラリ 1 ファイルで minify して書き出し、
// register.js からは相対パスで import する。自前のコード（register.js）は読める形のまま残す。
// どちらもディレクトリ掲載の「1 ファイル 256 KiB 未満」に余裕を持って収めるため（全部を 1 ファイルにすると 400 KiB を超える）。
// 出力は Claude Code の検証（claude plugin validate）に合わせて `export const register = ...` の形に整える
// （bun は `var register = ...; export { register }` と書き出すが、検証は前者の形しか受け付けない）。
import { cp, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const hooksDir = path.join(root, 'hooks')
const vendorDir = path.join(hooksDir, 'vendor')
// Codex プラグイン（plugins/codex）。Claude Code 版と同じ構成（hooks/hooks.json → scripts/hook.sh → hooks/cli.js）で、
// cli.js は src/codex-cli.ts から作り、依存は同じ hooks/vendor/*.js を plugins/codex/hooks/vendor/ にも書き出す。
// 実行時に pluginRoot から読む同梱ファイル（rules/、scripts/dogwood/、scripts/gate.schema.json）もコピーする
// （Codex はプラグインのディレクトリだけを取り込むので、プラグインの中で完結している必要がある）。
const codexDir = path.join(root, 'plugins', 'codex')
const codexHooksDir = path.join(codexDir, 'hooks')
const codexVendorDir = path.join(codexHooksDir, 'vendor')

// hooks/vendor/<name>.js に切り出す依存と、その中身（再 export するだけのエントリ）。
const vendors: Record<string, string> = {
  yaml: "export * from 'yaml'\n",
  i18next: "export { default } from 'i18next'\nexport * from 'i18next'\n",
}

// 1 ファイルの上限（ディレクトリ掲載の制限は 256 KiB 未満）。余裕を見てこれを超えたらビルドを失敗させる。
const maxBytes = 200 * 1024

const build = async (config: Parameters<typeof Bun.build>[0]): Promise<string> => {
  const result = await Bun.build({ target: 'browser', format: 'esm', ...config })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const code = await result.outputs[0]?.text()
  if (code === undefined) throw new Error('bundle produced no output')
  return code
}

const outputs: Record<string, string> = {}

const scratch = path.join(root, 'node_modules', '.cache', 'vendor-entries')
for (const [name, entry] of Object.entries(vendors)) {
  const entryPath = path.join(scratch, `${name}.ts`)
  await Bun.write(entryPath, entry)
  const vendorCode = await build({ entrypoints: [entryPath], minify: true })
  outputs[path.join(vendorDir, `${name}.js`)] = vendorCode
  outputs[path.join(codexVendorDir, `${name}.js`)] = vendorCode
}

let code = await build({
  entrypoints: [path.join(root, 'src', 'register.ts')],
  external: ['claude-code', ...Object.keys(vendors)],
  minify: false,
})
// 外に出した依存の import を hooks/vendor/ への相対パスに差し替える。
const useVendor = (text: string): string => {
  for (const name of Object.keys(vendors)) {
    text = text.replace(new RegExp(`(\\bfrom\\s*)(['"])${name}\\2`, 'g'), `$1$2./vendor/${name}.js$2`)
  }
  return text
}
code = useVendor(code)
code = code.replace(/^var register = /m, 'export const register = ').replace(/\nexport \{\n {2}register\n\};\n?$/, '\n')
if (!/^export const register = /m.test(code)) throw new Error('register export not found in bundle')
// ディレクトリの検査は、権限を判定するフック（classic.PreToolUse）の引数と同じ名前が、そのフックの外を含めて
// ファイルのどこかで宣言・代入されていると、判定をユーザーに残していることを確かめられず提出を止める。
// 引数名がフックの中にしか出てこないことをここで確かめる。
{
  const lines = code.split('\n')
  const start = lines.findIndex((l) => l.includes('on("classic.PreToolUse", async ('))
  const end = lines.findIndex((l, i) => i > start && l.startsWith('  });'))
  const params = lines[start]
    ?.match(/async \(([^)]*)\) =>/)?.[1]
    ?.split(',')
    .map((p) => p.trim())
  if (start < 0 || end < 0 || params?.length !== 3) throw new Error('classic.PreToolUse hook not found in bundle')
  for (const name of params) {
    const rx = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`)
    const outside = lines.findIndex((l, i) => (i < start || i > end) && rx.test(l))
    if (outside >= 0) throw new Error(`classic.PreToolUse parameter ${name} also appears outside the hook (line ${outside + 1})`)
  }
  // 検査はフックの中のイベント引数を、メンバーの読み取り（e.tool）か、関数の引数として丸ごと渡す形しか読まない
  // （分割代入・テンプレート・オブジェクトやリストの中などに置くと、判定をユーザーに残していると確かめられない）。
  const [, eventName] = params
  const body = lines.slice(start + 1, end + 1).join('\n')
  const uses = body.matchAll(new RegExp(`(?<![\\w$.])${eventName}(?![\\w$])`, 'g'))
  for (const use of uses) {
    const before = body.slice(0, use.index).trimEnd()
    const after = body.slice((use.index ?? 0) + eventName.length).trimStart()
    const member = after.startsWith('.') && !after.startsWith('...')
    const argument = /[(,]$/.test(before) && /^[),]/.test(after) && !before.endsWith('...')
    if (!member && !argument) {
      throw new Error(
        `classic.PreToolUse uses its event parameter ${eventName} outside a member read or a call argument: ...${before.slice(-40)}${eventName}${after.slice(0, 20)}...`,
      )
    }
  }
}
outputs[path.join(hooksDir, 'register.js')] = code

// settings hook の CLI（hooks/cli.js）。`node hooks/cli.js <Event>` で動く普通の Node プログラムで、mod の実行環境の制約
// （node: の import 禁止など）は受けない。yaml / i18next は register.js と同じ hooks/vendor/*.js を相対 import で共有する。
const cliCode = useVendor(
  await build({ entrypoints: [path.join(root, 'src', 'cli.ts')], target: 'node', external: ['claude-code', ...Object.keys(vendors)], minify: false }),
)
const cliFile = path.join(hooksDir, 'cli.js')
outputs[cliFile] = cliCode

// Codex プラグインの CLI（plugins/codex/hooks/cli.js）。cli.js と同じ Node プログラム（src/host.ts の cliMain）で、ホストが src/host-codex.ts。
const codexCliCode = useVendor(
  await build({
    entrypoints: [path.join(root, 'src', 'codex-cli.ts')],
    target: 'node',
    external: ['claude-code', ...Object.keys(vendors)],
    minify: false,
  }),
)
const codexCliFile = path.join(codexHooksDir, 'cli.js')
outputs[codexCliFile] = codexCliCode

// 見えない文字（改行・タブ以外の制御文字、半角スペース以外の空白、書式文字）を \uXXXX に書き換える。
// ディレクトリの検査は、文字列やコメントに生の見えない文字があると保留にする（yaml の "\x85" / "\xa0" など）。
// minify 後のこれらは文字列リテラルの中にしか現れないので、エスケープしても意味は変わらない。書き換え後に構文を確かめる。
const invisible = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/gu
const escapeInvisible = (text: string) =>
  text.replace(invisible, (ch) => {
    if (ch === '\n' || ch === '\t' || ch === '\r' || ch === ' ') return ch
    const cp = ch.codePointAt(0) ?? 0
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
const transpiler = new Bun.Transpiler({ loader: 'js' })
for (const [file, text] of Object.entries(outputs)) {
  const escaped = escapeInvisible(text)
  if (escaped === text) continue
  transpiler.transformSync(escaped)
  outputs[file] = escaped
}

// 実行環境が解決できない import が残っていないことを確かめる（claude-code と相対パス以外は不可）。
const forbidden = [/(^|[;}\s])import\s*[^'"(]*from\s*['"](?!\.{1,2}\/|claude-code['"])/m, /(^|[;}\s])import\s*['"]/m, /\bimport\(/, /['"]node:/, /\brequire\(/]
// cli.js は Node で動くので node: の組み込みモジュールは import してよい（それ以外の外部の import や動的な読み込みは不可）。
const forbiddenCli = [/(^|[;}\s])import\s*[^'"(]*from\s*['"](?!\.{1,2}\/|node:)/m, /(^|[;}\s])import\s*['"]/m, /\bimport\(/, /\brequire\(/]
for (const [file, text] of Object.entries(outputs)) {
  const rel = path.relative(root, file)
  const rules = file === cliFile || file === codexCliFile ? forbiddenCli : forbidden
  for (const rx of rules) if (rx.test(text)) throw new Error(`${rel} contains a forbidden pattern: ${rx}`)
  const bytes = new TextEncoder().encode(text).length
  if (bytes >= maxBytes) throw new Error(`${rel} is ${(bytes / 1024).toFixed(0)} KiB; keep each file under ${maxBytes / 1024} KiB`)
}

await rm(vendorDir, { recursive: true, force: true })
await rm(codexVendorDir, { recursive: true, force: true })
for (const [file, text] of Object.entries(outputs)) {
  await Bun.write(file, text)
  console.log(`wrote ${path.relative(root, file)} (${(new TextEncoder().encode(text).length / 1024).toFixed(0)} KiB)`)
}

// Codex プラグインが実行時に読む同梱ファイルを、リポジトリのものからコピーする（元を編集したら bun run build で揃える。CI も同じ）。
const bundledAssets = ['rules', path.join('scripts', 'dogwood'), path.join('scripts', 'gate.schema.json')]
for (const rel of bundledAssets) {
  const dest = path.join(codexDir, rel)
  await rm(dest, { recursive: true, force: true })
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(path.join(root, rel), dest, { recursive: true })
  console.log(`copied ${rel} -> ${path.relative(root, dest)}`)
}
