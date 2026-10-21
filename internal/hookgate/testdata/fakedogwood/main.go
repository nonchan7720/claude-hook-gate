// Command fakedogwood is a stand-in for the dogwood binary used by the gate tests
// (port of FAKE_DOGWOOD_SRC in tests/helpers/gate.ts).
//
// It reads a JSON config from the file named by FAKE_DOGWOOD_CONF:
//
//	{"verdict":"allow","mode":"ok","deny":[],"deny_after_first_call":[],"calls":"<jsonl path>"}
//
// appends {"argv": [...], "trace": "<contents of --trace file>"} to the calls file, and answers
// with the configured verdict (or fails / prints garbage / prints no verdicts, depending on mode).
package main

import (
	"encoding/json"
	"os"
	"strings"
)

type conf struct {
	Verdict            string   `json:"verdict"`
	Mode               string   `json:"mode"`
	Deny               []string `json:"deny"`
	DenyAfterFirstCall []string `json:"deny_after_first_call"`
	Calls              string   `json:"calls"`
}

type call struct {
	Argv  []string `json:"argv"`
	Trace string   `json:"trace"`
}

func lastLine(t string) string {
	last := ""
	for _, l := range strings.Split(strings.TrimSpace(t), "\n") {
		if l != "" {
			last = l
		}
	}
	return last
}

func anyIn(subs []string, s string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func fatal(msg string) {
	os.Stderr.WriteString(msg + "\n")
	os.Exit(1)
}

func main() {
	raw, err := os.ReadFile(os.Getenv("FAKE_DOGWOOD_CONF"))
	if err != nil {
		fatal(err.Error())
	}
	var c conf
	if err := json.Unmarshal(raw, &c); err != nil {
		fatal(err.Error())
	}
	argv := os.Args[1:]
	trace := ""
	for i, a := range argv {
		if a == "--trace" && i+1 < len(argv) {
			b, err := os.ReadFile(argv[i+1])
			if err != nil {
				fatal(err.Error())
			}
			trace = string(b)
			break
		}
	}
	var prior []call
	if b, err := os.ReadFile(c.Calls); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.TrimSpace(l) == "" {
				continue
			}
			var pc call
			if json.Unmarshal([]byte(l), &pc) == nil {
				prior = append(prior, pc)
			}
		}
	}
	line, _ := json.Marshal(call{Argv: argv, Trace: trace})
	f, err := os.OpenFile(c.Calls, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fatal(err.Error())
	}
	_, _ = f.Write(append(line, '\n'))
	_ = f.Close()

	switch c.Mode {
	case "fail":
		os.Stderr.WriteString("boom\n")
		os.Exit(1)
	case "broken":
		os.Stdout.WriteString("<<not json>>")
		return
	case "empty":
		os.Stdout.WriteString(`{"verdicts":[]}`)
		return
	}

	last := lastLine(trace)
	verdict := c.Verdict
	switch {
	case anyIn(c.DenyAfterFirstCall, last):
		for _, p := range prior {
			if anyIn(c.DenyAfterFirstCall, lastLine(p.Trace)) {
				verdict = "deny"
				break
			}
		}
	case anyIn(c.Deny, last):
		verdict = "deny"
	}
	out, _ := json.Marshal(map[string]any{"verdicts": []any{map[string]any{"index": 0, "verdict": verdict}}})
	os.Stdout.Write(out)
}
