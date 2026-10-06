// フックモジュールを依存ごと 1 つの ESM（hooks/register.js）にまとめる。
//
// mod の実行環境（Claude Code が直接 ES モジュールとして読む）はプラグイン内の相対 import と
// `claude-code` しか解決できないので、`yaml` などの依存はここでバンドルして取り込む。
// 出力は Claude Code の検証（claude plugin validate）に合わせて `export const register = ...` の形に整える
// （bun は `var register = ...; export { register }` と書き出すが、検証は前者の形しか受け付けない）。
import * as path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const out = path.join(root, 'hooks', 'register.js')

const result = await Bun.build({
  entrypoints: [path.join(root, 'src', 'register.ts')],
  target: 'browser',
  format: 'esm',
  external: ['claude-code'],
  minify: false,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

let code = await result.outputs[0]?.text()
if (code === undefined) throw new Error('bundle produced no output')

code = code.replace(/^var register = /m, 'export const register = ').replace(/\nexport \{\n {2}register\n\};\n?$/, '\n')

// 実行環境が解決できない import が残っていないことを確かめる（claude-code と相対パス以外は不可）。
const forbidden = [/^\s*import\s[^'"]*from\s*['"](?!\.{1,2}\/|claude-code['"])/m, /^\s*import\s*['"]/m, /\bimport\(/, /['"]node:/, /\brequire\(/]
for (const rx of forbidden) if (rx.test(code)) throw new Error(`bundle contains a forbidden pattern: ${rx}`)
if (!/^export const register = /m.test(code)) throw new Error('register export not found in bundle')

await Bun.write(out, code)
console.log(`wrote ${path.relative(root, out)} (${(code.length / 1024).toFixed(0)} KiB)`)
