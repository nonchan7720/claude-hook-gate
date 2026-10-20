// Codex の command hook（plugins/codex/hooks/hooks.json）の入口: `node plugins/codex/hooks/cli.js <Event>`。
import { cliMain } from './host.ts'
import { codexHost } from './host-codex.ts'

await cliMain(codexHost)
