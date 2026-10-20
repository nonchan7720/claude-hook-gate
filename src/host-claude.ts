// Claude Code の settings hook（hooks/hooks.json）向けの Host。classic の JSON は中核の形そのものなので normalize は素通し。
import type { PluginOptions } from 'claude-code'
import { CLAUDE_CONFIG_DIRS } from './config-dir.ts'
import { CORE_EVENTS, type CoreEvent, type Host } from './host.ts'
import { outcomeToClassic } from './outcome.ts'

/** プラグイン設定は CLAUDE_PLUGIN_OPTION_<key>（boolean は "true" / "false" の文字列）で届く。 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): PluginOptions {
  const opt = (key: string): string | undefined => env[`CLAUDE_PLUGIN_OPTION_${key}`]
  return {
    language: opt('language'),
    agentLaunchGuard: opt('agentLaunchGuard') === 'true',
    autoCount: opt('autoCount') !== 'false',
    rulesFile: opt('rulesFile'),
  }
}

export const claudeHost: Host = {
  appName: 'Claude Code',
  events: CORE_EVENTS,
  configDirNames: CLAUDE_CONFIG_DIRS,
  options: optionsFromEnv,
  normalize: (event, payload) => ({ event: event as CoreEvent, payloads: [payload] }),
  render: (event, outcome, stderr) => outcomeToClassic(event, outcome, stderr),
}
