import type { Io } from './io.ts'
import { join } from './path.ts'

/** PATH から実行可能なコマンドを探す（shutil.which / command -v 相当）。 */
export async function which(io: Io, name: string): Promise<string | undefined> {
  if (name.includes('/')) return (await io.isExecutable(name)) ? name : undefined
  for (const dir of (io.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (await io.isExecutable(candidate)) return candidate
  }
  return undefined
}
