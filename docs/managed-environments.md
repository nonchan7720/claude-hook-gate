# Managed environments

[← README](../README.md) · [日本語](ja/managed-environments.md)

Where an organization manages Claude Code (Team / Enterprise login, or managed settings), a built-in guard skips the plugin's function hooks, the mod (`/plugin` shows "Its hooks on classic.SessionStart, ... do not run here"). The mod does not run in Cowork either.

There the same checks are done by a Go binary, `feedback-gate`, started from the command hooks in `hooks/hooks.json`. Its decisions (deny, ask, block, added context) are the same as the mod's.

## Getting the binary

`scripts/hook.sh` looks for it in this order:

1. The environment variable `FEEDBACK_GATE_BIN` (the path of an executable)
2. The cache: `${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate`
3. A download from the GitHub release (`feedback-gate_<os>_<arch>.tar.gz` and `checksums.txt`; the SHA-256 is checked before the binary goes into the cache)

- The version always matches the installed plugin.
- The download happens once per version, inside the first hook (SessionStart). Set `FEEDBACK_GATE_BIN` to avoid it.
- Supported: linux and darwin, amd64 and arm64.
- The cache of another version that has not been used for more than 30 days is removed automatically.
- `FEEDBACK_GATE_RELEASE_BASE_URL` replaces the download location.

## When it cannot be installed

If there is no binary and it cannot be downloaded, the hook does nothing (your work is not stopped) and prints one line to stderr:

```
feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing
```

| `<reason>` | Cause |
| --- | --- |
| `no-download-tool` | Neither `curl` nor `wget` |
| `no-sha256-tool` | Neither `sha256sum` nor `shasum` |
| `download-failed` | The network cannot be reached |
| `checksum-mismatch` | The checksum does not match |
| `unsupported-platform` | Unsupported OS or CPU |
| `extract-failed`, `cache-unwritable`, `no-cache-dir`, `bad-version` | Extracting or writing to the cache failed |

## Relation to the mod

- **No double run.** Where the mod runs, it writes a per-session marker and the command hook does nothing when it sees it.
- **Settings.** The plugin settings arrive as environment variables such as `CLAUDE_PLUGIN_OPTION_language`.
- **Display.** The status-line text shown during an evaluation is a mod-only feature.
