// 設定ディレクトリ（<project>/.claude と <project>/.agents、~/.claude と ~/.agents）の候補と解決。
import type { Io } from './io.ts'
import { join } from './path.ts'

/** Claude Code の候補。Codex は逆順（src/host-codex.ts）。 */
export const CLAUDE_CONFIG_DIRS: readonly string[] = ['.claude', '.agents']

/**
 * 状態ファイルを置く設定ディレクトリ: 候補のうち最初に存在するもの。どれも無ければ先頭。
 * 一方が他方へのシンボリックリンクでも、存在する先頭の候補に決まるので置き場所は 1 つになる。
 */
export async function pickConfigDir(names: readonly string[], base: string, exists: (path: string) => Promise<boolean>): Promise<string> {
  for (const name of names) if (await exists(join(base, name))) return join(base, name)
  return join(base, names[0] ?? '.claude')
}

/** base 直下の各候補に rel を付けたパス（存在は見ない）。 */
export const configPaths = (io: Io, base: string, ...rel: string[]): string[] => io.configDirNames.map((name) => join(base, name, ...rel))

/** base/<候補>/rel のうち最初に存在するもの。 */
export async function findConfigPath(io: Io, base: string, ...rel: string[]): Promise<string | undefined> {
  for (const path of configPaths(io, base, ...rel)) if (await io.exists(path)) return path
  return undefined
}

/** プロジェクトの gate.yaml（候補のうち最初に存在するもの）。 */
export const findGateYaml = (io: Io, base: string = io.projectDir || io.cwd): Promise<string | undefined> => findConfigPath(io, base, 'gate.yaml')
