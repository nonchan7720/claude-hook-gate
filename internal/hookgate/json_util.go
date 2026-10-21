package hookgate

import (
	"bytes"
	"encoding/json"
	"strings"
)

// JSONString は文字列を JSON の文字列リテラルにする（HTML エスケープなし。JSON.stringify に近い）。
func JSONString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return `""`
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// JSONStringify は JSON.stringify(v) 相当（HTML エスケープなし、末尾の改行なし）。エンコードできなければ "null"。
func JSONStringify(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// KV は OMap の 1 要素。
type KV struct {
	Key string
	Val any
}

// OMap は挿入順を保つ JSON オブジェクト（JS のオブジェクトと同じキー順で出力するため）。
type OMap []KV

// MarshalJSON は挿入順のまま出力する。
func (m OMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, kv := range m {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(JSONString(kv.Key))
		buf.WriteByte(':')
		var vb bytes.Buffer
		enc := json.NewEncoder(&vb)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(kv.Val); err != nil {
			return nil, err
		}
		buf.WriteString(strings.TrimSuffix(vb.String(), "\n"))
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}
