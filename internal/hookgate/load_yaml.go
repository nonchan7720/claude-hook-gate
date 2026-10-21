package hookgate

// YAML の読み込み（gate.yaml と feedback ルールの frontmatter）。
// 元の実装は PyYAML（YAML 1.1）の safe_load だったので、同じ 1.1 の書き方（yes/no/on/off が真偽値、アンカー・エイリアス・
// merge key あり）で読む。y / n は PyYAML と同じく文字列。キーの重複は PyYAML と同じく後勝ち。
// gopkg.in/yaml.v3 で yaml.Node まで構文解析し、素のスカラーの型は自前で PyYAML の規則に従って決める。
// 戻り値の型は map[string]any / []any / string / int / float64 / bool / nil。

import (
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	yamlTrueRe  = regexp.MustCompile(`^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$`)
	yamlFalseRe = regexp.MustCompile(`^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$`)
	yamlNullRe  = regexp.MustCompile(`^(?:~|null|Null|NULL|)$`)

	yamlBinRe    = regexp.MustCompile(`^[-+]?0b[0-1_]+$`)
	yamlOctRe    = regexp.MustCompile(`^[-+]?0[0-7_]+$`)
	yamlDecRe    = regexp.MustCompile(`^[-+]?(?:0|[1-9][0-9_]*)$`)
	yamlHexRe    = regexp.MustCompile(`^[-+]?0x[0-9a-fA-F_]+$`)
	yamlSexaRe   = regexp.MustCompile(`^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$`)
	yamlFloatRe  = regexp.MustCompile(`^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$`)
	yamlSexaFRe  = regexp.MustCompile(`^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$`)
	yamlInfRe    = regexp.MustCompile(`^[-+]?\.(?:inf|Inf|INF)$`)
	yamlNaNRe    = regexp.MustCompile(`^\.(?:nan|NaN|NAN)$`)
	yamlMaxDepth = 10000
)

// ParseYaml は text を YAML 1.1（PyYAML 互換）として読む。空の文書は nil。壊れていればエラー。
func ParseYaml(text string) (any, error) {
	dec := yaml.NewDecoder(strings.NewReader(text))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil //nolint:nilnil // 空の文書は null
		}
		return nil, err
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err == nil {
		return nil, errors.New("expected a single document in the stream")
	} else if !errors.Is(err, io.EOF) {
		return nil, err
	}
	c := &yamlConv{seen: map[*yaml.Node]any{}}
	return c.convert(&doc, 0)
}

type yamlConv struct {
	seen map[*yaml.Node]any
}

func (c *yamlConv) convert(n *yaml.Node, depth int) (any, error) {
	if depth > yamlMaxDepth {
		return nil, errors.New("yaml: document nested too deeply")
	}
	switch n.Kind {
	case 0:
		return nil, nil //nolint:nilnil // 空
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil //nolint:nilnil // 空の文書は null
		}
		return c.convert(n.Content[0], depth+1)
	case yaml.AliasNode:
		return c.convert(n.Alias, depth+1)
	case yaml.ScalarNode:
		return resolveYamlScalar(n), nil
	case yaml.SequenceNode:
		if v, ok := c.seen[n]; ok {
			return v, nil
		}
		out := make([]any, 0, len(n.Content))
		for _, e := range n.Content {
			v, err := c.convert(e, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		c.seen[n] = out
		return out, nil
	case yaml.MappingNode:
		if v, ok := c.seen[n]; ok {
			return v, nil
		}
		out, err := c.convertMapping(n, depth)
		if err != nil {
			return nil, err
		}
		c.seen[n] = out
		return out, nil
	}
	return nil, fmt.Errorf("yaml: unsupported node kind %d", n.Kind)
}

func isMergeKey(k *yaml.Node) bool {
	return k.Kind == yaml.ScalarNode && k.Value == "<<" && k.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) == 0 &&
		(k.Tag == "!!merge" || k.Tag == "" || k.Tag == "!!str")
}

func (c *yamlConv) convertMapping(n *yaml.Node, depth int) (map[string]any, error) {
	explicit := map[string]any{}
	merged := map[string]any{}
	for i := 0; i+1 < len(n.Content); i += 2 {
		k, v := n.Content[i], n.Content[i+1]
		if isMergeKey(k) {
			if err := c.mergeInto(merged, v, depth); err != nil {
				return nil, err
			}
			continue
		}
		key, err := c.convert(k, depth+1)
		if err != nil {
			return nil, err
		}
		val, err := c.convert(v, depth+1)
		if err != nil {
			return nil, err
		}
		explicit[yamlKeyString(key)] = val
	}
	// 明示したキーは merge されたキーに勝つ（PyYAML と同じ）
	for k, v := range explicit {
		merged[k] = v
	}
	return merged, nil
}

// mergeInto は `<<:` の値（マッピング、またはマッピングのリスト）を dst に足す。先に出たものが優先。
func (c *yamlConv) mergeInto(dst map[string]any, v *yaml.Node, depth int) error {
	val, err := c.convert(v, depth+1)
	if err != nil {
		return err
	}
	put := func(m map[string]any) {
		for k, x := range m {
			if _, ok := dst[k]; !ok {
				dst[k] = x
			}
		}
	}
	switch x := val.(type) {
	case map[string]any:
		put(x)
	case []any:
		for _, e := range x {
			m, ok := e.(map[string]any)
			if !ok {
				return errors.New("yaml: expected a mapping for merging, but found a non-mapping")
			}
			put(m)
		}
	default:
		return errors.New("yaml: expected a mapping or list of mappings for merging")
	}
	return nil
}

func yamlKeyString(k any) string {
	if k == nil {
		return "null"
	}
	return Str(k)
}

// resolveYamlScalar は素のスカラーを PyYAML の規則で型付けする。引用符・ブロックスカラーは常に文字列。
func resolveYamlScalar(n *yaml.Node) any {
	s := n.Value
	if n.Style&yaml.TaggedStyle != 0 {
		switch n.Tag {
		case "!!str", "!!binary", "!!timestamp":
			return s
		case "!!null":
			return nil
		case "!!bool":
			if yamlTrueRe.MatchString(s) {
				return true
			}
			if yamlFalseRe.MatchString(s) {
				return false
			}
			return s
		case "!!int", "!!float":
			if v, ok := resolveYamlNumber(s); ok {
				return v
			}
			return s
		}
		return s
	}
	if n.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
		return s
	}
	if yamlNullRe.MatchString(s) {
		return nil
	}
	if yamlTrueRe.MatchString(s) {
		return true
	}
	if yamlFalseRe.MatchString(s) {
		return false
	}
	if v, ok := resolveYamlNumber(s); ok {
		return v
	}
	return s
}

func stripUnderscore(s string) string { return strings.ReplaceAll(s, "_", "") }

func parseIntBase(s string, base int) (any, bool) {
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimLeft(s, "+-")
	n, err := strconv.ParseInt(s, base, 64)
	if err != nil {
		f, ferr := strconv.ParseUint(s, base, 64)
		if ferr != nil {
			return nil, false
		}
		v := float64(f)
		if neg {
			v = -v
		}
		return v, true
	}
	if neg {
		n = -n
	}
	return int(n), true
}

func resolveYamlNumber(s string) (any, bool) {
	switch {
	case yamlBinRe.MatchString(s):
		t := stripUnderscore(s)
		neg := strings.HasPrefix(t, "-")
		t = strings.TrimLeft(t, "+-")[2:]
		v, ok := parseIntBase(t, 2)
		if neg && ok {
			return negate(v), true
		}
		return v, ok
	case yamlHexRe.MatchString(s):
		t := stripUnderscore(s)
		neg := strings.HasPrefix(t, "-")
		t = strings.TrimLeft(t, "+-")[2:]
		v, ok := parseIntBase(t, 16)
		if neg && ok {
			return negate(v), true
		}
		return v, ok
	case yamlDecRe.MatchString(s):
		return parseIntBase(stripUnderscore(s), 10)
	case yamlOctRe.MatchString(s):
		t := stripUnderscore(s)
		neg := strings.HasPrefix(t, "-")
		t = strings.TrimLeft(t, "+-")
		v, ok := parseIntBase(t, 8)
		if neg && ok {
			return negate(v), true
		}
		return v, ok
	case yamlSexaRe.MatchString(s):
		t := stripUnderscore(s)
		neg := strings.HasPrefix(t, "-")
		t = strings.TrimLeft(t, "+-")
		total := 0
		for _, part := range strings.Split(t, ":") {
			n, err := strconv.Atoi(part)
			if err != nil {
				return nil, false
			}
			total = total*60 + n
		}
		if neg {
			total = -total
		}
		return total, true
	case yamlFloatRe.MatchString(s):
		f, err := strconv.ParseFloat(stripUnderscore(s), 64)
		if err != nil {
			return nil, false
		}
		return f, true
	case yamlSexaFRe.MatchString(s):
		t := stripUnderscore(s)
		neg := strings.HasPrefix(t, "-")
		t = strings.TrimLeft(t, "+-")
		total := 0.0
		for _, part := range strings.Split(t, ":") {
			f, err := strconv.ParseFloat(part, 64)
			if err != nil {
				return nil, false
			}
			total = total*60 + f
		}
		if neg {
			total = -total
		}
		return total, true
	case yamlInfRe.MatchString(s):
		if strings.HasPrefix(s, "-") {
			return math.Inf(-1), true
		}
		return math.Inf(1), true
	case yamlNaNRe.MatchString(s):
		return math.NaN(), true
	}
	return nil, false
}

func negate(v any) any {
	switch x := v.(type) {
	case int:
		return -x
	case float64:
		return -x
	}
	return v
}
