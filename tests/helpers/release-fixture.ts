// テスト用: GoReleaser が作るリリースの置き場（<base>/v<version>/feedback-gate_<os>_<arch>.tar.gz と checksums.txt）のまがいものを作る。
// hook.sh は FEEDBACK_GATE_RELEASE_BASE_URL=file://<base> でここから偽のバイナリを取ってくる（オフラインで動く）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** GoReleaser の {{ .Os }}_{{ .Arch }} に当たる、この環境の値。hook.sh が対応しない環境では undefined。 */
export function releasePlatform(): string | undefined {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : undefined
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined
  return os && arch ? `${os}_${arch}` : undefined
}

/** 偽の feedback-gate。呼ばれたら 引数|CLAUDE_PLUGIN_ROOT|標準入力 を $CALLS に追記して終わる。 */
export const FAKE_BINARY_SCRIPT = `#!/bin/sh\nprintf 'feedback-gate|%s|%s|' "$*" "$CLAUDE_PLUGIN_ROOT" >> "$CALLS"\ncat >> "$CALLS"\nprintf '\\n' >> "$CALLS"\n`

export type Release = { base: string; archive: string }

/**
 * <dir>/release/v<version>/ に偽のアーカイブと checksums.txt を作る。tamper を指定すると checksums.txt のハッシュをわざと違うものにする。
 * 戻り値の base が FEEDBACK_GATE_RELEASE_BASE_URL（file:// つき）の元になるディレクトリ。
 */
export function makeRelease(dir: string, version: string, opts: { tamper?: boolean } = {}): Release {
  const platform = releasePlatform()
  if (!platform) throw new Error('unsupported platform for the release fixture')
  const base = path.join(dir, 'release')
  const versionDir = path.join(base, `v${version}`)
  const stage = path.join(dir, 'stage')
  fs.mkdirSync(versionDir, { recursive: true })
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, 'feedback-gate'), FAKE_BINARY_SCRIPT, { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'LICENSE'), 'MIT\n')
  const archive = `feedback-gate_${platform}.tar.gz`
  const tar = spawnSync('tar', ['-czf', path.join(versionDir, archive), '-C', stage, 'feedback-gate', 'LICENSE'], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  const hash = createHash('sha256')
    .update(fs.readFileSync(path.join(versionDir, archive)))
    .digest('hex')
  const shown = opts.tamper ? hash.replace(/^./, hash.startsWith('0') ? '1' : '0') : hash
  const other = createHash('sha256').update('other').digest('hex')
  fs.writeFileSync(path.join(versionDir, 'checksums.txt'), `${other}  feedback-gate_windows_amd64.zip\n${shown}  ${archive}\n`)
  return { base, archive }
}

/** プラグインのルート（.claude-plugin/plugin.json に version だけ書いたもの）を作る。 */
export function makePluginRoot(dir: string, version: string): string {
  const root = path.join(dir, 'plugin-root')
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), `{\n  "name": "feedback-gate",\n  "version": "${version}"\n}\n`)
  return root
}
