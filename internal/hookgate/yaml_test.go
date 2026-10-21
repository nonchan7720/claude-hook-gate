package hookgate

import (
	"math"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mustYaml(t *testing.T, text string) any {
	t.Helper()
	v, err := ParseYaml(text)
	require.NoError(t, err)
	return v
}

func TestParseYaml(t *testing.T) {
	t.Run("scalars, nested maps and block sequences", func(t *testing.T) {
		doc := mustYaml(t, "name: sample\ncount: 4\nratio: 1.5\nenabled: true\ndisabled: false\nnothing:\ntilde: ~\nnested:\n  a: 1\n  b:\n    - x\n    - y\n")
		assert.Equal(t, map[string]any{
			"name": "sample", "count": 4, "ratio": 1.5, "enabled": true, "disabled": false, "nothing": nil, "tilde": nil,
			"nested": map[string]any{"a": 1, "b": []any{"x", "y"}},
		}, doc)
	})

	t.Run("sequence at the same indent as its key, sequence of mappings", func(t *testing.T) {
		assert.Equal(t, map[string]any{"run": []any{"a", "b"}, "next": 1}, mustYaml(t, "run:\n- a\n- b\nnext: 1\n"))
		doc := mustYaml(t, "rules:\n  - match: \"**/*.py\"\n    run:\n      - ruff check .\n      - cmd: pytest -q\n        timeout: 60\n  - match: [a, b]\n")
		assert.Equal(t, map[string]any{"rules": []any{
			map[string]any{"match": "**/*.py", "run": []any{"ruff check .", map[string]any{"cmd": "pytest -q", "timeout": 60}}},
			map[string]any{"match": []any{"a", "b"}},
		}}, doc)
	})

	t.Run("quoted scalars keep regex backslashes in single quotes", func(t *testing.T) {
		doc := mustYaml(t, "a: 'go (test|vet)\\b'\nb: 'it''s'\nc: \"tab\\there\"")
		assert.Equal(t, map[string]any{"a": `go (test|vet)\b`, "b": "it's", "c": "tab\there"}, doc)
	})

	t.Run("block scalars", func(t *testing.T) {
		assert.Equal(t, map[string]any{"run": []any{"echo a\necho b\n", "echo c"}}, mustYaml(t, "run:\n  - |\n    echo a\n    echo b\n  - echo c\n"))
	})

	t.Run("JSON is valid input", func(t *testing.T) {
		obj := map[string]any{
			"rules":  []any{map[string]any{"match": "**/*.py", "per_file_dir": true, "run": []any{`echo "hi: there"`, map[string]any{"cmd": "x", "timeout": 3}}}},
			"policy": false,
		}
		assert.Equal(t, obj, mustYaml(t, JSONStringify(obj)))
	})

	t.Run("empty documents are null", func(t *testing.T) {
		assert.Nil(t, mustYaml(t, ""))
		assert.Nil(t, mustYaml(t, "# only a comment\n"))
	})

	// PyYAML との互換性（YAML 1.1）を固定する。
	t.Run("YAML 1.1 booleans: yes/no/on/off are booleans, as in PyYAML", func(t *testing.T) {
		assert.Equal(t, map[string]any{"a": true, "b": false, "c": true, "d": false}, mustYaml(t, "a: yes\nb: off\nc: On\nd: No\n"))
	})

	t.Run("duplicate keys: the last one wins, as in PyYAML", func(t *testing.T) {
		assert.Equal(t, map[string]any{"a": 2}, mustYaml(t, "a: 1\na: 2\n"))
	})

	t.Run("y / n are plain strings, as in PyYAML", func(t *testing.T) {
		assert.Equal(t, map[string]any{"a": "y", "b": "n", "c": []any{"y", "n"}}, mustYaml(t, "a: y\nb: n\nc: [y, n]\n"))
	})

	t.Run("anchors, aliases and merge keys are supported", func(t *testing.T) {
		assert.Equal(t, map[string]any{"base": map[string]any{"x": 1}, "use": map[string]any{"x": 1, "z": 2}}, mustYaml(t, "base: &b {x: 1}\nuse:\n  <<: *b\n  z: 2\n"))
	})

	t.Run("explicit keys win over merged keys, earlier merged maps win over later ones", func(t *testing.T) {
		doc := mustYaml(t, "a: &a {x: 1, y: 1}\nb: &b {y: 2, z: 2}\nc:\n  y: 9\n  <<: [*a, *b]\n")
		assert.Equal(t, map[string]any{"x": 1, "y": 9, "z": 2}, doc.(map[string]any)["c"])
	})

	t.Run("numbers: ints stay int, floats float64, 1.1 forms", func(t *testing.T) {
		doc := mustYaml(t, "a: 0x1f\nb: 010\nc: 1_000\nd: -3\ne: .inf\nf: 1e3\ng: '5'\n").(map[string]any)
		assert.Equal(t, 31, doc["a"])
		assert.Equal(t, 8, doc["b"])
		assert.Equal(t, 1000, doc["c"])
		assert.Equal(t, -3, doc["d"])
		assert.True(t, math.IsInf(doc["e"].(float64), 1))
		assert.Equal(t, "1e3", doc["f"]) // PyYAML も . の無い指数表記は文字列
		assert.Equal(t, "5", doc["g"])
	})

	t.Run("malformed YAML is an error", func(t *testing.T) {
		_, err := ParseYaml("a: [1, 2\n")
		assert.Error(t, err)
		_, err = ParseYaml("a: 1\n  b: 2\n")
		assert.Error(t, err)
	})

	// tests/yaml.spec.ts の "differences from the YAML 1.2 parser built into Bun" は Bun.YAML との比較なので移植しない。
}
