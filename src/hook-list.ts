// スラッシュコマンド /hook-list: このプロジェクトで feedback-gate が何をいつ動かすかを、ブラウザの画面で一覧にする。
// 一覧を作るのは Go のバイナリ（`feedback-gate claude hook-list`、internal/hookgate/hook_list.go）で、ここは
// scripts/hook-list.sh（バイナリを探す・取ってくる）を実行してその 1 行の結果を返すだけ。settings hook の環境や Codex でも
// 同じスクリプトから同じ画面が出る。

import type { PluginOptions } from 'claude-code'
import type { Io } from './io.ts'
import { join } from './path.ts'

// 初回はバイナリのダウンロードが入りうるので長めに待つ。
const TIMEOUT_MS = 120_000

/** プラグイン設定を、Go 版が読む環境変数（CLAUDE_PLUGIN_OPTION_*。settings hook に渡るのと同じ名前）にする。 */
export function optionEnv(options: PluginOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['language', 'agentLaunchGuard', 'autoCount', 'rulesFile']) {
    const v = options[key]
    if (typeof v === 'string' || typeof v === 'boolean') env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(v)
  }
  return env
}

// mod が見ている環境変数のうち、Go 版が同じ読み方をするもの（置き場所と言語）。mod の見え方と食い違わないよう、そのまま渡す。
const PASS_ENV = ['HOME', 'CLAUDE_FEEDBACK_DIR', 'FEEDBACK_GATE_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const

function passEnv(io: Io): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASS_ENV) {
    const v = io.env[key]
    if (v !== undefined && v !== '') env[key] = v
  }
  return env
}

/** /hook-list 本体。args（`--no-open` など）はそのまま渡す。失敗しても例外にせず、理由を text に出す。 */
export async function hookListCommand(io: Io, args: string, options: PluginOptions = {}): Promise<{ text: string; context: string[] }> {
  const argv = ['bash', join(io.pluginRoot, 'scripts', 'hook-list.sh'), 'claude', ...args.split(/\s+/).filter((a) => a !== '')]
  const r = await io.run(argv, {
    cwd: io.cwd,
    env: { ...passEnv(io), ...optionEnv(options), CLAUDE_PROJECT_DIR: io.projectDir || io.cwd, CLAUDE_PLUGIN_ROOT: io.pluginRoot },
    timeoutMs: TIMEOUT_MS,
  })
  const out = r.stdout.trim()
  if (r.exitCode === 0 && out !== '') return { text: out, context: [] }
  const reason = [r.stderr.trim(), r.error ?? '', r.timedOut ? 'timed out' : ''].filter((s) => s !== '').join('\n')
  return { text: `[hook-list] failed (exit ${r.exitCode})${reason === '' ? '' : `:\n${reason}`}`, context: [] }
}
