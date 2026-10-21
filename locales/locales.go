// Package locales embeds the message catalogs (en.yaml / ja.yaml) used by the hooks.
package locales

import "embed"

// FS holds en.yaml and ja.yaml.
//
//go:embed en.yaml ja.yaml
var FS embed.FS

// EN and JA are the raw YAML texts of the catalogs.
var (
	EN = mustRead("en.yaml")
	JA = mustRead("ja.yaml")
)

func mustRead(name string) []byte {
	b, err := FS.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return b
}
