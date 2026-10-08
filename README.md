# my_scripts

Personal browser userscripts plus compatibility pointers for CLI integrations maintained in dedicated repositories.

## ChatGPT browser userscripts

| Function | Userscript | Install / update | Documentation |
| --- | --- | --- | --- |
| Compress long conversations, Turbo, tool-call folding | **ChatGPT Recent Messages** (v0.8.7) | [Install](https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.user.js) | [Recent Turns](userscripts/chatgpt-recent-turns/README.md) |
| Show a chat's project name in Recents | **ChatGPT Project Labels** (v1.0.0) | [Install](https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-project-labels.user.js) | [Project Labels](userscripts/chatgpt-project-labels/README.md) |

These are **two independent ScriptCat userscripts**. You can update, enable, and disable either one without affecting the other. The existing Recent Messages script keeps its original userscript identity, so v0.8.7 updates over older installs rather than creating a duplicate.

To use both features, update Recent Messages to v0.8.7 and separately install Project Labels v1.0.0. Then refresh ChatGPT.

## Repository layout

- `chatgpt-recent-turns.user.js` / `.meta.js` — conversation compression and Turbo
- `chatgpt-project-labels.user.js` / `.meta.js` — project suffixes in Recents
- `userscripts/chatgpt-recent-turns/README.md` — compression documentation
- `userscripts/chatgpt-project-labels/README.md` — project-label documentation
- `tests/` — userscript regression checks

## Other projects

| Category | Project | Canonical location |
| --- | --- | --- |
| Codex CLI hook | Auto Thread Title | https://github.com/nonlog/codex-auto-thread-title |
| Windows CLI integration | Completion notifications for Codex / Claude Code / Pi | https://github.com/nonlog/windows-cli-notify |
| Pi extension | Auto Session Title | https://github.com/nonlog/pi-auto-session-title |
| Claude Code title hook | Retired; use Claude Code built-in auto-title | [Retirement note](docs/retired/claude-auto-session-title.md) |

## Release policy

- Preserve each script's existing `@name` and `@namespace` so ScriptCat updates correctly.
- Publish the complete `.user.js` and documentation before its corresponding `.meta.js`.
- Use GitHub Actions for verification; do not build or package locally or on a VPS.
