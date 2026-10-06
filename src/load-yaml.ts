// YAML の読み込み（gate.yaml と feedback ルールの frontmatter）。
// 元の実装は PyYAML（YAML 1.1）の safe_load だったので、同じ 1.1 スキーマ（yes/no/on/off が真偽値、
// アンカー・エイリアス・merge key あり）で読む。キーの重複は PyYAML と同じく後勝ちにする。
// `yaml` パッケージの 1.1 スキーマは y / n も真偽値にするが、PyYAML はしないので、真偽値の書き方だけ PyYAML に合わせる。
import { parse, type ScalarTag } from 'yaml'

const PY_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/
const PY_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/

const pyBool = (original: ScalarTag): ScalarTag => ({
  ...original,
  test: /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON|no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  resolve: (str: string) => (PY_TRUE.test(str) ? true : PY_FALSE.test(str) ? false : (str as unknown as boolean)),
})

export const parseYaml = (text: string): unknown =>
  parse(text, {
    schema: 'yaml-1.1',
    uniqueKeys: false,
    logLevel: 'error',
    customTags: (tags) => tags.map((t) => (typeof t === 'object' && 'tag' in t && t.tag === 'tag:yaml.org,2002:bool' ? pyBool(t as ScalarTag) : t)),
  })
