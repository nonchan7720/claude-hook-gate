// settings hook（hooks/hooks.json）の入口: `node hooks/cli.js <Event>`。組織管理のガードが mod の classic.* を飛ばす環境でも
// settings hook は飛ばされないので、同じ処理（src/hooks.ts）をこちらからも走らせる。
import { cliMain } from './host.ts'
import { claudeHost } from './host-claude.ts'

await cliMain(claudeHost)
