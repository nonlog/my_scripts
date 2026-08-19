# my_scripts

Personal scripts, CLI utilities, and browser userscripts.

## CLI session naming

The repository tracks the currently recommended automatic conversation-title setup for the coding CLIs I use.

| CLI | Current approach | Repository status |
|---|---|---|
| Claude Code | Built-in AI auto-title | Custom hook retired; migration note only |
| Codex CLI | `UserPromptSubmit` + official app-server `thread/read` / `thread/name/set` | Maintained here |
| Pi | Community `furbyhaxx/pi-session-naming` extension using Pi-native session APIs | Local custom extension retired; migration/install note only |

### Claude Code

Recent Claude Code builds can generate conversation titles natively, so the old custom `auto_session_title.py` hook is no longer needed. See [`claude-auto-session-title/README.md`](claude-auto-session-title/README.md) for migration notes. Validated with Claude Code 2.1.235 on 2026-08-19.

### Codex CLI

[`codex-auto-thread-title/`](codex-auto-thread-title/) remains the maintained custom integration. It never writes Codex SQLite or rollout files directly; it reads authoritative thread metadata through app-server and persists names with `thread/name/set`. Validated with Codex CLI 0.148.0 on 2026-08-19.

### Pi

The old local `auto-session-title.ts` implementation has been retired in favor of the community [`furbyhaxx/pi-session-naming`](https://github.com/furbyhaxx/pi-session-naming) extension. See [`pi-auto-session-title/README.md`](pi-auto-session-title/README.md) for the install command and the lightweight model configuration used here. Validated with Pi 0.84.2 on 2026-08-19.

## ChatGPT Recent Messages

`chatgpt-recent-turns.user.js` reduces rendering work and client-side conversation-state overhead in very long ChatGPT Web conversations, especially Agent chats with many tool calls.

### v0.7.0 behavior

- Shows the latest **5 currently materialized messages** by default.
- Reveals **5 older messages** at a time when you scroll near the top.
- Uses a compact vertical icon toolbar with browser-language tooltips.
- After about **4 seconds of inactivity**, the toolbar collapses to one small round icon.
- The expanded toolbar now also has a **manual collapse button**.
- The toolbar can be **dragged** using the grip at its top; its position is persisted in `localStorage`.
- Dropping the toolbar within about **48 px** of the left or right screen edge docks it to that edge.
- A docked toolbar partially slides off-screen after about **700 ms** of inactivity and slides fully back into view when the pointer returns.
- Keeps Tool Compactor enabled by default: consecutive `Called tool` rows are hidden and represented by one lightweight bundle button.
- Uses the incremental Tool Compactor introduced in v0.4.1, avoiding the previous restore/rebuild cycle during tool streaming.
- Keeps Adaptive Turbo enabled by default for unusually heavy conversations.
- Includes **Deep Turbo**: if the newest single user turn itself becomes extremely tool-heavy, the initial client mapping keeps the user node plus only the most recent internal tail instead of retaining the entire huge turn.
- Does not modify or delete the server-side ChatGPT conversation.

### Controls

- Drag grip: move the toolbar.
- Up arrow: load 5 older materialized messages.
- Lines icon: show all currently materialized messages / return to recent messages.
- Reset icon: return to the latest 5 messages.
- Lightning icon: toggle Turbo mode and reload.
- Tools/sliders icon: toggle Tool Compactor immediately.
- Collapse icon: manually collapse the expanded toolbar.
- Collapsed toolbar icon: reopen the full toolbar.

## Install with ScriptCat

The repository is public, so ScriptCat can install the userscript directly from GitHub Raw.

Canonical install URL:

```text
https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.user.js
```

With ScriptCat installed, open that URL in the browser and confirm the install/update page. The script keeps the same `@name` + `@namespace`, so installing a newer version updates the existing script rather than creating a separately named script.

### Remote updates

The userscript includes:

```text
@updateURL   https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.meta.js
@downloadURL https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.user.js
```

`chatgpt-recent-turns.meta.js` is a small metadata-only file used for update checks. The full `.user.js` file is downloaded only when ScriptCat installs an update.

For future releases:

1. Increase `@version` in **both** `chatgpt-recent-turns.user.js` and `chatgpt-recent-turns.meta.js`.
2. Commit the complete `.user.js` first.
3. Update README if needed.
4. Commit `.meta.js` **last**, so remote clients only see the new version after the full userscript is already available.

Do not change `@namespace` unless you intentionally want ScriptCat to treat it as a different userscript identity.

## Turbo details

Turbo intercepts the initial conversation `GET` response before ChatGPT stores the full mapping in long-lived client state.

Normal Adaptive Turbo:

- Keeps at most 3 recent user turns.
- Uses approximately 450 path nodes / 700 KB serialized-message budgets.

Deep Turbo additionally activates when the latest user turn alone exceeds roughly **260 internal nodes** or **500 KB** of serialized message data. It keeps the latest user node plus about **120 recent internal nodes**, rewiring the retained chain locally for that page load.

Disable Turbo and reload whenever you need the full older client-side history in that tab.

## Limitations

ChatGPT already performs its own DOM virtualization, so hiding DOM elements alone cannot eliminate every slowdown. Tool-heavy conversations may still accumulate large live React/client state while an Agent continues running after the page has loaded.

Tool Compactor intentionally keeps React-owned nodes intact for compatibility. Deep Turbo only changes the client-side mapping returned to that page load; it does not edit the server-side conversation.

ChatGPT Web DOM structure and private conversation response formats are not stable public APIs and may require selector or trimming updates in the future.
