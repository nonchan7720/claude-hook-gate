package hookgate

// tests/reset-gate.spec.ts の移植。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResetGate(t *testing.T) {
	run := func(proj, sessionID, source string, hasSource bool) ScriptResult {
		payload := Dict{"session_id": sessionID}
		if hasSource {
			payload["source"] = source
		}
		return ResetGate(MakeIo(IoOpts{ProjectDir: proj}), payload)
	}
	startup := func(proj string, sessionID string, source string) ScriptResult {
		return run(proj, sessionID, source, true)
	}

	age := func(p string) {
		old := time.Unix(1, 0) // 1970 年付近（秒）
		require.NoError(t, os.Chtimes(p, old, old))
	}

	stateDir := func(proj string) string { return filepath.Join(proj, ".claude", ".gate-status") }

	makeStateFiles := func(proj, id string) []string {
		dir := stateDir(proj)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		names := []string{"changed_files." + id + ".txt", "gate_attempts." + id + ".txt", "gate_passed." + id + ".txt", "gate_pending_checks." + id + ".json"}
		contents := []string{"a.py\n", "1\n", "b.py\n", "{\"go-build\": [\"c.py\"]}\n"}
		files := []string{}
		for i, n := range names {
			f := filepath.Join(dir, n)
			require.NoError(t, os.WriteFile(f, []byte(contents[i]), 0o644))
			files = append(files, f)
		}
		return files
	}

	legacyNames := []string{
		"changed_files.{sid}.txt",
		"gate_attempts.{sid}.txt",
		"gate_passed.{sid}.txt",
		"gate_pending_checks.{sid}.json",
		"gate_trace.{sid}.jsonl",
		"gate_deferred.{sid}.json",
		"gate_push_verified.{sid}.txt",
		"gate_reported.{sid}.txt",
		"feedback_gate_attempts.{sid}.txt",
	}

	// 移行前の置き場所（.claude/ 直下と .claude/hooks/logs/<state_id>/）に残った状態ファイル。
	makeLegacyStateFiles := func(proj, id string) []string {
		claudeDir := filepath.Join(proj, ".claude")
		require.NoError(t, os.MkdirAll(claudeDir, 0o755))
		paths := []string{}
		for _, n := range legacyNames {
			p := filepath.Join(claudeDir, strings.ReplaceAll(n, "{sid}", id))
			require.NoError(t, os.WriteFile(p, []byte("x\n"), 0o644))
			paths = append(paths, p)
		}
		logDir := filepath.Join(claudeDir, "hooks", "logs", id)
		require.NoError(t, os.MkdirAll(logDir, 0o755))
		log := filepath.Join(logDir, "cmd.1.log")
		require.NoError(t, os.WriteFile(log, []byte("x\n"), 0o644))
		return append(paths, log)
	}

	makeFeedbackAttempts := func(proj, id string) string {
		require.NoError(t, os.MkdirAll(stateDir(proj), 0o755))
		p := filepath.Join(stateDir(proj), "feedback_gate_attempts."+id+".txt")
		require.NoError(t, os.WriteFile(p, []byte("1\n"), 0o644))
		return p
	}

	makePolicyState := func(proj, id string) []string {
		WriteTraceRecords(proj, id, []Dict{{"ts": 1, "root": proj, "cwd": proj, "name": "n", "cmd": "c", "kind": "request"}})
		WriteDeferred(proj, id, []any{Dict{"root": proj, "cwd": proj, "name": "n", "cmd": "c", "timeout": 300, "label": "."}})
		return []string{TracePath(proj, id), DeferredPath(proj, id)}
	}

	allGone := func(files ...string) {
		for _, f := range files {
			assert.False(t, Exists(f), f)
		}
	}
	allKept := func(files ...string) {
		for _, f := range files {
			assert.True(t, Exists(f), f)
		}
	}

	t.Run("reset-gate by SessionStart source", func(t *testing.T) {
		t.Run("deletes state on startup and clear, prints nothing", func(t *testing.T) {
			WithTmp(func(proj string) {
				files := makeStateFiles(proj, "sess1")
				r := startup(proj, "sess1", "startup")
				assert.Equal(t, 0, r.ExitCode)
				assert.Equal(t, "", r.Stdout)
				allGone(files...)
				files2 := makeStateFiles(proj, "sess1")
				startup(proj, "sess1", "clear")
				allGone(files2...)
			})
		})

		t.Run("deletes bash_started on startup and keeps it on resume", func(t *testing.T) {
			WithTmp(func(proj string) {
				dir := stateDir(proj)
				require.NoError(t, os.MkdirAll(dir, 0o755))
				files := []string{}
				for _, n := range []string{"bash_started.sess1.json", "bash_started.sess1--agent1.json", "bash_started.sess1--toolu_01.json"} {
					f := filepath.Join(dir, n)
					require.NoError(t, os.WriteFile(f, []byte("{\"tool_use_id\":\"t\",\"started\":1}\n"), 0o644))
					files = append(files, f)
				}
				startup(proj, "sess1", "resume")
				allKept(files...)
				startup(proj, "sess1", "startup")
				allGone(files...)
			})
		})

		t.Run("deletes subagent reports on startup, keeps them on resume, prunes stale ones", func(t *testing.T) {
			WithTmp(func(proj string) {
				dir := stateDir(proj)
				require.NoError(t, os.MkdirAll(dir, 0o755))
				mine := filepath.Join(dir, "subagent_report.sess1--a1.json")
				other := filepath.Join(dir, "subagent_report.sess2--a1.json")
				for _, f := range []string{mine, other} {
					require.NoError(t, os.WriteFile(f, []byte("{\"gate\":\"[gate] ok\"}\n"), 0o644))
				}
				startup(proj, "sess1", "resume")
				allKept(mine, other)
				age(other)
				startup(proj, "sess1", "startup")
				allGone(mine, other)
			})
		})

		t.Run("keeps state on resume, compact, unknown source and missing source", func(t *testing.T) {
			WithTmp(func(proj string) {
				files := makeStateFiles(proj, "sess1")
				type src struct {
					source string
					has    bool
				}
				for _, s := range []src{{"resume", true}, {"compact", true}, {"something-new", true}, {"", false}} {
					r := run(proj, "sess1", s.source, s.has)
					assert.Equal(t, 0, r.ExitCode)
					assert.Equal(t, "", r.Stdout)
					allKept(files...)
				}
			})
		})

		t.Run("agent suffixed state is deleted on startup / clear and kept on resume", func(t *testing.T) {
			WithTmp(func(proj string) {
				files := makeStateFiles(proj, "sess1--agent1")
				startup(proj, "sess1", "resume")
				allKept(files...)
				startup(proj, "sess1", "startup")
				allGone(files...)
				files2 := makeStateFiles(proj, "sess1--agent1")
				startup(proj, "sess1", "clear")
				allGone(files2...)
			})
		})

		t.Run("always prunes stale sessions regardless of source", func(t *testing.T) {
			WithTmp(func(proj string) {
				cur := makeStateFiles(proj, "sess-current")
				stale := makeStateFiles(proj, "sess-stale")
				for _, f := range stale {
					age(f)
				}
				r := startup(proj, "sess-current", "resume")
				assert.Equal(t, 0, r.ExitCode)
				allKept(cur...)
				allGone(stale...)
			})
		})
	})

	t.Run("reset-gate legacy paths", func(t *testing.T) {
		t.Run("deletes legacy state on startup", func(t *testing.T) {
			WithTmp(func(proj string) {
				files := append(makeLegacyStateFiles(proj, "sess1"), makeLegacyStateFiles(proj, "sess1--agent1")...)
				assert.Equal(t, 0, startup(proj, "sess1", "startup").ExitCode)
				allGone(files...)
			})
		})

		t.Run("keeps legacy state on resume", func(t *testing.T) {
			WithTmp(func(proj string) {
				files := makeLegacyStateFiles(proj, "sess1")
				assert.Equal(t, 0, startup(proj, "sess1", "resume").ExitCode)
				allKept(files...)
			})
		})

		t.Run("prunes stale legacy state regardless of source", func(t *testing.T) {
			WithTmp(func(proj string) {
				stale := makeLegacyStateFiles(proj, "sess-stale")
				for _, f := range stale {
					age(f)
				}
				age(filepath.Dir(stale[len(stale)-1]))
				assert.Equal(t, 0, startup(proj, "sess-current", "resume").ExitCode)
				allGone(stale...)
			})
		})

		t.Run("does not touch gate.yaml", func(t *testing.T) {
			WithTmp(func(proj string) {
				WriteGateYaml(proj, Dict{"rules": []any{}})
				startup(proj, "sess1", "startup")
				assert.True(t, Exists(filepath.Join(proj, ".claude", "gate.yaml")))
			})
		})
	})

	t.Run("reset-gate feedback attempts", func(t *testing.T) {
		t.Run("deletes on startup / clear, agent suffixed too", func(t *testing.T) {
			WithTmp(func(proj string) {
				a := makeFeedbackAttempts(proj, "sess1")
				startup(proj, "sess1", "startup")
				allGone(a)
				b := makeFeedbackAttempts(proj, "sess1")
				startup(proj, "sess1", "clear")
				allGone(b)
				c := makeFeedbackAttempts(proj, "sess1--agent1")
				startup(proj, "sess1", "startup")
				allGone(c)
			})
		})

		t.Run("keeps on resume, prunes stale ones", func(t *testing.T) {
			WithTmp(func(proj string) {
				cur := makeFeedbackAttempts(proj, "sess1")
				agent := makeFeedbackAttempts(proj, "sess1--agent1")
				startup(proj, "sess1", "resume")
				allKept(cur, agent)

				stale := makeFeedbackAttempts(proj, "sess-stale")
				age(stale)
				startup(proj, "sess1", "resume")
				allGone(stale)
				allKept(cur)
			})
		})
	})

	t.Run("reset-gate pending files", func(t *testing.T) {
		t.Run("removes pending files including agent suffixed, on startup", func(t *testing.T) {
			WithTmp(func(proj string) {
				WritePending(proj, "sess1", Dict{proj: Dict{"chk": []any{"x.py"}}})
				WritePending(proj, "sess1--agent1", Dict{proj: Dict{"chk": []any{"y.py"}}})
				assert.Equal(t, 0, startup(proj, "sess1", "startup").ExitCode)
				allGone(PendingPath(proj, "sess1"), PendingPath(proj, "sess1--agent1"))
			})
		})

		t.Run("keeps pending file on resume, prunes a stale one", func(t *testing.T) {
			WithTmp(func(proj string) {
				WritePending(proj, "sess1", Dict{proj: Dict{"chk": []any{"x.py"}}})
				WritePending(proj, "sess-stale", Dict{proj: Dict{"chk": []any{"x.py"}}})
				age(PendingPath(proj, "sess-stale"))
				startup(proj, "sess1", "resume")
				allKept(PendingPath(proj, "sess1"))
				allGone(PendingPath(proj, "sess-stale"))
			})
		})
	})

	t.Run("reset-gate policy state (trace / deferred)", func(t *testing.T) {
		t.Run("deletes on startup and agent suffixed on clear", func(t *testing.T) {
			WithTmp(func(proj string) {
				a := makePolicyState(proj, "sess1")
				startup(proj, "sess1", "startup")
				allGone(a...)
				b := makePolicyState(proj, "sess1--agent1")
				startup(proj, "sess1", "clear")
				allGone(b...)
			})
		})

		t.Run("keeps on resume, prunes stale regardless of source", func(t *testing.T) {
			WithTmp(func(proj string) {
				cur := makePolicyState(proj, "sess1")
				startup(proj, "sess1", "resume")
				allKept(cur...)
				stale := makePolicyState(proj, "sess-stale")
				for _, f := range stale {
					age(f)
				}
				startup(proj, "sess-current", "resume")
				allGone(stale...)
			})
		})
	})

	t.Run("reset-gate status summary", func(t *testing.T) {
		summary := func(proj string, sessionID ...string) string {
			id := "sess1"
			if len(sessionID) > 0 {
				id = sessionID[0]
			}
			return filepath.Join(stateDir(proj), "summary."+id+".txt")
		}
		put := func(proj string, sessionID ...string) {
			fbtWrite(summary(proj, sessionID...), "[gate] 完了: ✓ 1 (0.1s)")
		}

		t.Run("the kept gate summary is deleted on startup / clear and kept on resume", func(t *testing.T) {
			WithTmp(func(proj string) {
				put(proj)
				startup(proj, "sess1", "resume")
				assert.True(t, Exists(summary(proj)))
				startup(proj, "sess1", "startup")
				assert.False(t, Exists(summary(proj)))
				put(proj)
				startup(proj, "sess1", "clear")
				assert.False(t, Exists(summary(proj)))
			})
		})

		t.Run("another session summary is left alone", func(t *testing.T) {
			WithTmp(func(proj string) {
				put(proj, "sess1")
				put(proj, "sess2")
				startup(proj, "sess1", "startup")
				assert.False(t, Exists(summary(proj, "sess1")))
				assert.True(t, Exists(summary(proj, "sess2")))
			})
		})

		t.Run("prunes a stale summary of another session regardless of source", func(t *testing.T) {
			WithTmp(func(proj string) {
				put(proj, "sess-stale")
				put(proj, "sess-live")
				age(summary(proj, "sess-stale"))
				startup(proj, "sess-current", "resume")
				assert.False(t, Exists(summary(proj, "sess-stale")))
				assert.True(t, Exists(summary(proj, "sess-live")))
			})
		})
	})

	t.Run("classic_seen marker", func(t *testing.T) {
		t.Run("prunes markers older than 24h and keeps fresh ones", func(t *testing.T) {
			WithTmp(func(proj string) {
				WithTmp(func(feedback string) {
					dir := filepath.Join(feedback, ".classic_seen")
					require.NoError(t, os.MkdirAll(dir, 0o755))
					require.NoError(t, os.WriteFile(filepath.Join(dir, "old"), []byte("1\n"), 0o644))
					require.NoError(t, os.WriteFile(filepath.Join(dir, "fresh"), []byte("1\n"), 0o644))
					age(filepath.Join(dir, "old"))
					// Codex のプラグイン層のマーカー（.codex_plugin_seen）も同じ。
					codexDir := filepath.Join(feedback, CodexPluginSeenDir)
					require.NoError(t, os.MkdirAll(codexDir, 0o755))
					require.NoError(t, os.WriteFile(filepath.Join(codexDir, "old"), []byte("1\n"), 0o644))
					require.NoError(t, os.WriteFile(filepath.Join(codexDir, "fresh"), []byte("1\n"), 0o644))
					age(filepath.Join(codexDir, "old"))
					ResetGate(MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{ClaudeFeedbackDir: feedback}}), Dict{"session_id": "sess1"})
					assert.False(t, Exists(filepath.Join(dir, "old")))
					assert.True(t, Exists(filepath.Join(dir, "fresh")))
					assert.False(t, Exists(filepath.Join(codexDir, "old")))
					assert.True(t, Exists(filepath.Join(codexDir, "fresh")))
				})
			})
		})
	})
}
