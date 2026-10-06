// プロジェクトルート / worktree ルートの判定（gate と feedback ルールで共通）。
import { basename, isAbsolute, join, normpath, relpath } from './path.ts'

export function relativize(p: string, projectDir: string): string {
  let rp = p
  if (isAbsolute(p)) rp = relpath(p, projectDir)
  if (rp.startsWith('./')) rp = rp.slice(2)
  return rp
}

/**
 * path（絶対 or projectDir 相対）の実パスが <projectDir>/.claude/worktrees/<name>/ 配下なら
 * [その worktree ルートの絶対パス, ルート相対パス] を、配下でなければ
 * [projectDir, projectDir 相対パス] を返す。
 */
export function splitRoot(projectDir: string, path: string): [root: string, rel: string] {
  const worktreesDir = normpath(join(projectDir, '.claude', 'worktrees'))
  const abs = normpath(isAbsolute(path) ? path : join(projectDir, path))
  const relToWt = relpath(abs, worktreesDir)
  if (relToWt !== '.' && relToWt !== '..' && !relToWt.startsWith('../')) {
    const slash = relToWt.indexOf('/')
    const name = slash < 0 ? relToWt : relToWt.slice(0, slash)
    const rest = slash < 0 ? '' : relToWt.slice(slash + 1)
    return [normpath(join(worktreesDir, name)), rest]
  }
  return [projectDir, relativize(path, projectDir)]
}

/** label 用: ルートが projectDir ならそのまま、worktree なら "<worktree名>/<rel>"。 */
export const rootLabel = (root: string, projectDir: string, rel: string): string => (root === projectDir ? rel : `${basename(root)}/${rel}`)
