// Codex の apply_patch の入力（src/apply-patch.ts）を、ファイルごとの Edit / Write の payload に読み替える。
import { describe, expect, test } from 'bun:test'
import { absolutePath, parsePatch, patchPayloads, patchText } from '../src/apply-patch.ts'

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.py',
  '+print("hi")',
  '+x = 1',
  '*** Update File: src/old.py',
  '@@ def f():',
  '     pass',
  '-    return 1',
  '+    return 2',
  '+    # TODO later',
  '*** End of File',
  '*** Update File: src/moved.py',
  '*** Move to: src/renamed.py',
  '@@',
  '+added',
  '*** Delete File: src/gone.py',
  '*** End Patch',
].join('\n')

describe('parsePatch', () => {
  test('ファイルごとに op / path / 追加行を取り出す', () => {
    const files = parsePatch(PATCH)
    expect(files).toEqual([
      { op: 'add', path: 'src/new.py', added: 'print("hi")\nx = 1' },
      { op: 'update', path: 'src/old.py', added: '    return 2\n    # TODO later' },
      { op: 'update', path: 'src/moved.py', movedTo: 'src/renamed.py', added: 'added' },
      { op: 'delete', path: 'src/gone.py', added: '' },
    ])
  })

  test('パッチの形をしていなければ空', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('echo hi')).toEqual([])
    expect(parsePatch('*** Begin Patch\n*** End Patch')).toEqual([])
  })

  test('CRLF と、End Patch の後ろのごみは無視する', () => {
    const files = parsePatch('*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n*** End Patch\r\nEOF\n')
    expect(files).toEqual([{ op: 'add', path: 'a.txt', added: 'one' }])
  })

  test('シェルの heredoc に包まれていても Begin Patch から読む', () => {
    const files = parsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\nEOF")
    expect(files).toEqual([{ op: 'add', path: 'a.txt', added: 'one' }])
  })
})

describe('patchText', () => {
  test('command → input → patch の順に、パッチを含む文字列を返す', () => {
    expect(patchText({ command: PATCH })).toBe(PATCH)
    expect(patchText({ input: PATCH })).toBe(PATCH)
    expect(patchText({ patch: PATCH })).toBe(PATCH)
    expect(patchText({ command: 'ls', input: PATCH })).toBe(PATCH)
    expect(patchText({ command: 'ls' })).toBe('')
    expect(patchText('nope')).toBe('')
  })
})

describe('absolutePath / patchPayloads', () => {
  test('相対パスは base 起点、絶対パスはそのまま', () => {
    expect(absolutePath('src/a.py', '/proj')).toBe('/proj/src/a.py')
    expect(absolutePath('/abs/a.py', '/proj')).toBe('/abs/a.py')
  })

  test('Add は Write（content）、Update は Edit（new_string）、Delete は除く。移動は移動先のパス', () => {
    const payload = { session_id: 's', cwd: '/proj', tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_use_id: 't1', agent_id: 'ag' }
    const out = patchPayloads(payload, '/proj')
    expect(out).toEqual([
      { ...payload, tool_name: 'Write', tool_input: { file_path: '/proj/src/new.py', content: 'print("hi")\nx = 1' } },
      { ...payload, tool_name: 'Edit', tool_input: { file_path: '/proj/src/old.py', old_string: '', new_string: '    return 2\n    # TODO later' } },
      { ...payload, tool_name: 'Edit', tool_input: { file_path: '/proj/src/renamed.py', old_string: '', new_string: 'added' } },
    ])
  })

  test('パッチでない tool_input は空', () => {
    expect(patchPayloads({ tool_name: 'apply_patch', tool_input: { command: 'ls' } }, '/proj')).toEqual([])
    expect(patchPayloads({ tool_name: 'apply_patch' }, '/proj')).toEqual([])
  })
})
