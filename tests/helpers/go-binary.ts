// テスト用: Go 製の feedback-gate バイナリの場所。TypeScript の統合テスト（tests/cli.spec.ts, tests/codex-cli.spec.ts）が子プロセスとして起動する。
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT } from './node-io.ts'

let built: string | undefined

/**
 * feedback-gate バイナリのパス。FEEDBACK_GATE_BIN が設定されていればそれを使う（CI は先にビルドしておく）。
 * 無ければ `go build ./cmd/feedback-gate` で node_modules/.cache/feedback-gate/ に 1 度だけビルドする。失敗したらビルドの出力つきで例外にする。
 */
export function feedbackGateBin(): string {
  const fromEnv = process.env.FEEDBACK_GATE_BIN
  if (fromEnv) return fromEnv
  if (built) return built
  const out = path.join(REPO_ROOT, 'node_modules', '.cache', 'feedback-gate', process.platform === 'win32' ? 'feedback-gate.exe' : 'feedback-gate')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  // bun test --parallel は複数のプロセスが同時にここへ来るので、プロセスごとの一時ファイルへビルドして rename で置く（半端なファイルを起動しない）。
  const tmp = `${out}.${process.pid}`
  const r = spawnSync('go', ['build', '-o', tmp, './cmd/feedback-gate'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`go build ./cmd/feedback-gate failed (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}):\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  }
  fs.renameSync(tmp, out)
  built = out
  return out
}
