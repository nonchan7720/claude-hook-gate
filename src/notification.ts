// Notification / Stop 時のデスクトップ通知（macOS の terminal-notifier）。
// type: notify（確認待ち）| stop（完了）。それ以外は何もしない。
import { type Io, ok, type ScriptResult } from './io.ts'
import { basename } from './path.ts'
import { type Dict, jqStr } from './pyutil.ts'
import { shellQuote } from './shell.ts'
import { which } from './which.ts'

const LABELS: Record<string, { label: string; fallback: string }> = {
  notify: { label: '確認待ち', fallback: '確認を待っています' },
  stop: { label: '完了', fallback: '応答が完了しました' },
}

const FRONT_WINDOW_SCRIPT =
  'tell application "System Events" to tell (first process whose frontmost is true) to get name of (first window whose value of attribute "AXMain" is true)'

export async function notification(io: Io, type: string, payload: Dict): Promise<ScriptResult> {
  const kind = LABELS[type]
  if (!kind) return ok()

  const cwd = jqStr(payload.cwd) || io.cwd
  const message = jqStr(payload.message) || kind.fallback

  // エディタのウィンドウはリポジトリルートで開かれていることが多く、サブディレクトリを渡すと既存ウィンドウが
  // そのフォルダを開き直してしまう
  const top = await io.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  const gitRoot = top.exitCode === 0 ? top.stdout.replace(/\n+$/, '') : ''
  const target = gitRoot || cwd
  const project = basename(target)

  // 対象を今まさに見ているなら通知しない。権限が無く前面ウィンドウ名を取れない場合は通知する
  // front window は名前の無い隠しウィンドウを拾うことがあるため AXMain で実ウィンドウを選ぶ
  const front = await io.run(['osascript', '-e', FRONT_WINDOW_SCRIPT])
  const frontName = front.exitCode === 0 ? front.stdout.replace(/\n+$/, '') : ''
  if (frontName.includes(project)) return ok()

  // TERM_PROGRAM は hook まで引き継がれないことがあるので、判別できたターミナル以外は VSCode 扱いにする。
  // Cursor / Windsurf も vscode を名乗るため実際の bundle id を優先する
  let isVscode = true
  let appBundle = 'com.microsoft.VSCode'
  switch (io.env.TERM_PROGRAM ?? '') {
    case 'vscode':
      appBundle = io.env.__CFBundleIdentifier || 'com.microsoft.VSCode'
      break
    case 'iTerm.app':
      appBundle = 'com.googlecode.iterm2'
      isVscode = false
      break
    case 'WarpTerminal':
      appBundle = 'dev.warp.Warp-Terminal'
      isVscode = false
      break
    case 'Ghostty':
      appBundle = 'com.mitchellh.ghostty'
      isVscode = false
      break
    case 'Apple_Terminal':
      appBundle = 'com.apple.Terminal'
      isVscode = false
      break
  }

  // -activate はアプリを前面に出すだけで、複数ウィンドウのうちどれかを選べない。
  // VSCode 系は code -r で対象を開いているウィンドウ自体にフォーカスさせる
  let click = `open -b ${shellQuote(appBundle)}`
  if (isVscode) {
    let codeBin = (await which(io, 'code')) ?? ''
    if (!(codeBin && (await io.isExecutable(codeBin)))) codeBin = '/usr/local/bin/code'
    if (await io.isExecutable(codeBin)) click = `${shellQuote(codeBin)} -r ${shellQuote(target)}`
  }

  if (!(await which(io, 'terminal-notifier'))) return ok()

  await io.run([
    'terminal-notifier',
    '-title',
    'Claude Code',
    '-subtitle',
    `📁 ${project} · ${kind.label}`,
    '-message',
    message,
    '-group',
    `claude-code-${target}`,
    '-execute',
    click,
  ])
  return ok()
}
