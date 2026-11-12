# Install

[← README](../README.md) · [日本語](ja/install.md)

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

The first command adds this repository as the `claude-hook-gate` marketplace; the second installs the `feedback-gate` plugin from it. Then choose the scope.

### Codex

The same hooks are also packaged as a [Codex](https://developers.openai.com/codex) plugin in [`plugins/codex/`](../plugins/codex/README.md) (catalog: `.agents/plugins/marketplace.json`). It reads the same feedback rules and the same `gate.yaml` (looking in `.agents/` first, then `.claude/`), so a project used with both tools is checked the same way:

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

then install `feedback-gate` from `/plugins`, run its `install-hooks.sh` once (below) and trust the hooks in `/hooks`. The plugin root is this repository (the Codex manifests `.codex-plugin/plugin.json` and `plugin.json` at the root point at `plugins/codex/hooks/hooks.json`), so `rules/`, `scripts/dogwood/` and `scripts/install-binary.sh` (the binary downloader) are shared, not copied. The checking logic is shared; what differs between the two hosts (Codex edits files with `apply_patch`, has `PermissionRequest` instead of `Notification`, and no `ask`) is isolated behind the `Host` interface of the Go binary (`Host` in `internal/hookgate/host.go`, implemented by `host_claude.go` and `host_codex.go` for `feedback-gate claude` / `feedback-gate codex`; `apply_patch.go` splits the patch). The TypeScript mod (`src/register.ts`) is Claude Code only and is unchanged. See the [plugin README](../plugins/codex/README.md) for the differences and the environment variables that replace the plugin settings. Codex does not run plugin-bundled hooks yet (its `plugin_hooks` feature is still under development), so after installing run `plugins/codex/scripts/install-hooks.sh` once, without arguments (or the one-liner `gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash`, which finds the newest installed version, runs its installer for you and installs the `feedback-gate-setup` command, which updates the plugin and refreshes the hooks in one go; see [Install](../plugins/codex/README.md#install)): it writes the same hooks into `~/.codex/hooks.json`, and a marker keeps that copy silent once the plugin's own hooks run. Where an organization's `requirements.toml` sets `allow_managed_hooks_only` (the Codex counterpart of the guard described under [Settings hooks for managed environments](managed-environments.md#settings-hooks-for-managed-environments)), only hooks in the managed layer run; on a machine you administer yourself the setup command detects the policy and installs into `/etc/codex/hooks.json` with `sudo` (`--system` when the policy comes from MDM or the workspace), otherwise `--print` / `--toml` produce the hooks for the administrator. The Codex sandbox also keeps Codex itself from writing under `.agents/` and `.codex/` in the project, so rules Codex should maintain belong in `.claude/`. See [Install](../plugins/codex/README.md#install), [If the hooks still do not run](../plugins/codex/README.md#if-the-hooks-still-do-not-run), [Putting the hooks in the managed layer yourself](../plugins/codex/README.md#putting-the-hooks-in-the-managed-layer-yourself) and [Rules and `gate.yaml` under the Codex sandbox](../plugins/codex/README.md#rules-and-gateyaml-under-the-codex-sandbox).

### Claude Cowork

Cowork in the Claude desktop app installs from the same marketplace. In Cowork, open **Customize → Plugins → Add marketplace**, add `nonchan7720/claude-hook-gate`, and install `feedback-gate` from the list (plugins installed in Cowork also sync to Claude Code 2.1.273 or later).

Cowork loads the plugin's command hooks in `hooks/hooks.json`, but it is not documented as a place where mods (the `register.js` in `modules` of `hooks.json`) run. So in Cowork the checks run through the same path as the [settings hooks for managed environments](managed-environments.md#settings-hooks-for-managed-environments): `scripts/hook.sh` → `feedback-gate claude <Event>` (the Go binary). The decisions (deny / ask, block, added context) are the same as the mod's. The differences:

- **Commands**: `/correct` and `/hook-list` are registered by the mod, so they do not appear. Use the [skills](commands-and-skills.md#skills) instead: `/feedback-gate:hook-list` for the list, `/feedback-gate:feedback` to write and review rules. The skills work in Cowork as they are.
- **Plugin options**: Cowork does not ask for `userConfig` values. Without `CLAUDE_PLUGIN_OPTION_*` the binary uses the defaults (`language: auto`, `agentLaunchGuard: false`, `autoCount: true`, `rulesFile` at `~/{.claude,.agents}/feedback-gate/feedback_rules.md`, falling back to the bundled rules file). The language follows `FEEDBACK_GATE_LANG` or the OS language.
- **Getting the binary**: the first time (and after each version bump) `scripts/install-binary.sh` downloads `feedback-gate_<os>_<arch>.tar.gz` and `checksums.txt` from the GitHub release. It needs `bash`, `curl` or `wget`, `tar`, `sha256sum` or `shasum`, and HTTPS to `github.com` and the host release files redirect to (`release-assets.githubusercontent.com`, formerly `objects.githubusercontent.com`). If any of these is missing the hooks do nothing and print one line with the reason on stderr (they never block your work). If your organization restricts Cowork's outbound hosts, ask for these hosts to be allowed, or point `FEEDBACK_GATE_BIN` at the binary.
- **Windows**: without Git for Windows Cowork runs hooks in PowerShell, so `scripts/hook.sh`, which needs `bash`, does not run. `install-binary.sh` also handles only Linux and macOS (amd64 / arm64), so on Windows the hooks currently do nothing.
- **Writing rules and `gate.yaml`**: Cowork refuses writes under the given folder's `.claude/` as a protected location, so Claude cannot create rules in `<project>/.claude/feedback/` there. The hooks also read `<project>/.agents/feedback/` (after `.claude/feedback/`; a rule of the same `name` in `.claude/` wins) and `<project>/.agents/gate.yaml` (when there is no `.claude/gate.yaml`), so in Cowork keep them there. The rules file injected into every prompt (`rules/feedback_rules.md`) and the skills `/feedback-gate:feedback` and `/feedback-gate:gate` tell Claude to switch to these paths when a write under `.claude/` is refused. The global `~/.claude/feedback/` is outside the folder Cowork works in, so copy rules meant for it there yourself.
- **Files it reads**: feedback rules (`~/{.claude,.agents}/feedback/*.md`) and `{.claude,.agents}/gate.yaml` are read from the home directory of the machine the hook runs on and from the folder you gave Cowork. Cowork does not read the Claude Code CLI's settings and plugins in `~/.claude`, but that does not stop the hook process from reading files itself.

The official docs do not list which events of `hooks.json` (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop) Cowork fires. After installing, check by adding one confirmed rule (`count: 3`) and seeing it injected into a prompt (UserPromptSubmit), and by editing a file in a folder with a `gate.yaml` and seeing the gate run (PostToolUse / Stop). If an event does not fire, please open an issue.

## Requirements

Nothing to install for the mod hooks: they are plain TypeScript, bundled into one JavaScript file that Claude Code runs itself (no Python, bash or jq).

- `curl` or `wget` and `bash` (optional): needed only by the settings hooks (`hooks/hooks.json`), once per plugin version, to download the `feedback-gate` binary (`tar` and `sha256sum` / `shasum` are required as well: without a hash tool nothing is installed). Without them, and while the binary is not cached, the settings hooks do nothing. `jq` is not required (used if present).

- `terminal-notifier` (optional, macOS): needed only for the desktop notifications.
- `dogwood` (optional; an AWS tool, source at <https://github.com/dogwood-policy/dogwood>). Build and install it with `cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli` (crate `amzn-dogwood-cli`, binary `dogwood`). The gate uses it to decide whether each `{.claude,.agents}/gate.yaml` command runs now or is deferred. It is looked up in `DOGWOOD_BIN`, `PATH`, `~/.cargo/bin/dogwood` and `~/.local/share/mise/shims/dogwood`, in that order. When it is not found, commands under the bundled default policy run every time, while commands under a `policy:` you set are skipped and deferred.
