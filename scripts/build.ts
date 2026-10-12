// フックモジュールを配布用の ESM（hooks/register.js と hooks/vendor/*.js）にまとめる。
//
// mod の実行環境（Claude Code が直接 ES モジュールとして読む）はプラグイン内の相対 import と
// `claude-code` しか解決できないので、`yaml` などの依存はここでバンドルして取り込む。
// 依存のライブラリ（yaml / i18next）は hooks/vendor/ に 1 ライブラリ 1 ファイルで minify して書き出し、
// register.js からは相対パスで import する。自前のコード（register.js）は読める形のまま残す。
// どちらもディレクトリ掲載の「1 ファイル 256 KiB 未満」に余裕を持って収めるため（全部を 1 ファイルにすると 400 KiB を超える）。
// 出力は Claude Code の検証（claude plugin validate）に合わせて `export const register = ...` の形に整える
// （bun は `var register = ...; export { register }` と書き出すが、検証は前者の形しか受け付けない）。
import { rm } from 'node:fs/promises'
import * as path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const hooksDir = path.join(root, 'hooks')
const vendorDir = path.join(hooksDir, 'vendor')

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
  outputs[path.join(vendorDir, `${name}.js`)] = await build({ entrypoints: [entryPath], minify: true })
}

let code = await build({
  entrypoints: [path.join(root, 'src', 'register.ts')],
  external: ['claude-code', ...Object.keys(vendors)],
  minify: false,
})
// 外に出した依存の import を hooks/vendor/ への相対パスに差し替える。
for (const name of Object.keys(vendors)) {
  code = code.replace(new RegExp(`(\\bfrom\\s*)(['"])${name}\\2`, 'g'), `$1$2./vendor/${name}.js$2`)
}
code = code.replace(/^var register = /m, 'export const register = ').replace(/\nexport \{\n {2}register\n\};\n?$/, '\n')
if (!/^export const register = /m.test(code)) throw new Error('register export not found in bundle')
outputs[path.join(hooksDir, 'register.js')] = code

// 実行環境が解決できない import が残っていないことを確かめる（claude-code と相対パス以外は不可）。
const forbidden = [/(^|[;}\s])import\s*[^'"(]*from\s*['"](?!\.{1,2}\/|claude-code['"])/m, /(^|[;}\s])import\s*['"]/m, /\bimport\(/, /['"]node:/, /\brequire\(/]
for (const [file, text] of Object.entries(outputs)) {
  const rel = path.relative(root, file)
  for (const rx of forbidden) if (rx.test(text)) throw new Error(`${rel} contains a forbidden pattern: ${rx}`)
  const bytes = new TextEncoder().encode(text).length
  if (bytes >= maxBytes) throw new Error(`${rel} is ${(bytes / 1024).toFixed(0)} KiB; keep each file under ${maxBytes / 1024} KiB`)
}

await rm(vendorDir, { recursive: true, force: true })
for (const [file, text] of Object.entries(outputs)) {
  await Bun.write(file, text)
  console.log(`wrote ${path.relative(root, file)} (${(new TextEncoder().encode(text).length / 1024).toFixed(0)} KiB)`)
}
