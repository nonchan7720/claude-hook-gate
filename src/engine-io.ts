// エンジンの `$` から Io を作る。hook モジュールはここ経由でしかファイルやプロセスに触れない。
import type { Engine } from 'claude-code'
import type { DirEntry, EnvVars, Io, RunOptions, RunResult, Stat } from './io.ts'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `$.env.get` は名前をソース上の文字列リテラルで書く必要があるので、参照する変数を1つずつ並べる。 */
async function readEnv($: Engine): Promise<EnvVars> {
  const [HOME, PATH, CLAUDE_FEEDBACK_DIR, DOGWOOD_BIN, TERM_PROGRAM, __CFBundleIdentifier] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('PATH'),
    $.env.get('CLAUDE_FEEDBACK_DIR'),
    $.env.get('DOGWOOD_BIN'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('__CFBundleIdentifier'),
  ])
  return { HOME, PATH, CLAUDE_FEEDBACK_DIR, DOGWOOD_BIN, TERM_PROGRAM, __CFBundleIdentifier }
}

export async function createIo($: Engine): Promise<Io> {
  const [env, projectDir, cwd] = await Promise.all([readEnv($), $.session.root(), $.session.cwd()])

  const stat = async (path: string): Promise<Stat | undefined> => {
    try {
      const s = await $.fs.stat(path)
      return { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  }

  const run = async (argv: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
    try {
      const r = await $.process.run(argv, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false }
    } catch (e) {
      // 起動できない・タイムアウトのどちらも process.run は拒否で返す（呼び出し側が経過時間で見分ける）。
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false, error: errorText(e) }
    }
  }

  const existing = async (paths: readonly string[]): Promise<string[]> => {
    const found: string[] = []
    for (const p of paths) if (await $.fs.exists(p).catch(() => false)) found.push(p)
    return found
  }

  return {
    env,
    projectDir,
    cwd,
    pluginRoot: $.plugin.root,
    readFile: (path) => $.fs.read(path).then(String, () => undefined),
    writeFile: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path).catch(() => false),
    stat,
    list: async (path): Promise<DirEntry[]> => {
      try {
        return (await $.fs.list(path)).map((e) => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs }))
      } catch {
        return []
      }
    },
    // エンジンの $.fs は実行権限ビットを返さないので、通常ファイルであることだけを確かめる。
    isExecutable: async (path) => (await stat(path))?.kind === 'file',
    // $.fs には削除が無いので、rm / rmdir を引数ベクタで直接呼ぶ（シェルは介さない）。
    removeFiles: async (paths) => {
      const found = await existing(paths)
      if (found.length > 0) await run(['rm', '-f', '--', ...found])
    },
    removeDir: async (path) => {
      if ((await stat(path))?.kind === 'dir') await run(['rmdir', '--', path])
    },
    removeTree: async (path) => {
      if (await $.fs.exists(path).catch(() => false)) await run(['rm', '-rf', '--', path])
    },
    run,
    now: () => $.clock.now(),
    progress: (text) => $.ui.status(text),
    result: (text) => $.ui.status(text),
    redraw: () => $.ui.invalidate('ui.render'),
    every: (ms, fn) => {
      const timer = $.clock.every(ms, fn)
      return () => timer.cancel()
    },
  }
}
