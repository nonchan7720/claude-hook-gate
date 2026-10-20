// Codex プラグイン（plugins/codex）の command hook の入口: `node hooks/cli.js <Event>`（plugins/codex/scripts/hook.sh から）。
// src/cli.ts（Claude Code の settings hook）と同じ作りで、ホストだけ Codex（src/host-codex.ts）に差し替える。
import { cliMain } from './host.ts'
import { codexHost } from './host-codex.ts'

await cliMain(codexHost)
