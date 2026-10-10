// `import text from './x.yaml' with { type: 'text' }` の型。bun（テスト実行時とバンドル時）はファイルの中身を
// 文字列として読み込む。tsc は中身を見ないので、ここで文字列と宣言しておく。
declare module '*.yaml' {
  const text: string
  export default text
}
