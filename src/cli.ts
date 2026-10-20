// settings hook（hooks/hooks.json の command hook）の入口: `node hooks/cli.js <Event>`。
// 組織管理のガード（cc-plugin-sec-default）が classic.* をユーザーの mod に対して飛ばす環境でも、settings hook は飛ばされない。
// classic コマンド hook と同じく stdin の JSON を受け取り、mod（src/register.ts）と同じイベントの処理（src/hooks.ts）を
// 走らせて、classic の規約（stdout の JSON・stderr・終了コード）で返す。ホストごとの違いは src/host-claude.ts、
// 共通の入口は src/host.ts（cliMain）。
import { cliMain } from './host.ts'
import { claudeHost } from './host-claude.ts'

await cliMain(claudeHost)
