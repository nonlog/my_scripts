# ChatGPT Recent Turns

`chatgpt-recent-turns.user.js` reduces rendering work and client-side conversation-state overhead in very long ChatGPT Web conversations, especially Agent chats with many tool calls.

### v0.8.2 behavior

- Shows the latest **5 currently materialized messages** by default.
- Reveals **5 older messages** at a time when you scroll near the top.
- Fixes the toolbar's older-message button under Turbo: after already-materialized hidden messages are exhausted, an explicit click fetches the next **5 older server turns** and opens them in a lightweight read-only history panel instead of restoring the full tool-heavy React state.
- Repeated older-message clicks continue backward using the server cursor. Automatic background history pagination remains blocked.
- Uses a compact vertical icon toolbar with browser-language tooltips.
- After about **4 seconds of inactivity**, the toolbar collapses to one small round icon.
- The expanded toolbar now also has a **manual collapse button**.
- The expanded toolbar can be **dragged** using the grip at its top, and the **collapsed floating button can also be dragged directly**; its position is persisted in `localStorage`.
- v0.8.1 separates click/tap from drag activation: the collapsed floating button opens reliably on release, including when docked/half-hidden, while drag starts only after the pointer moves past the drag threshold.
- Dropping the toolbar within about **48 px** of the left or right screen edge docks it to that edge.
- Docking first **collapses the toolbar to the floating button**, then partially slides that button off-screen after about **700 ms** of inactivity. Moving the pointer back over it reveals it again.
- **Turbo and Tool Compactor default to ON** on first install (an explicit user OFF setting is preserved).
- Tool Compactor hides consecutive `Called tool` rows behind one lightweight bundle button.
- Uses the incremental Tool Compactor introduced in v0.4.1, avoiding the previous restore/rebuild cycle during tool streaming.
- Keeps Adaptive Turbo enabled by default for unusually heavy conversations.
- Includes **Deep Turbo**: if the newest single user turn itself becomes extremely tool-heavy, the initial client mapping keeps the user node plus only the most recent internal tail instead of retaining the entire huge turn.
- Does not modify or delete the server-side ChatGPT conversation.

### Controls

- Drag grip: move the toolbar.
- Up arrow: reveal up to 5 older materialized messages; when none remain, manually fetch 5 older server turns into the lightweight history panel.
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

Turbo intercepts conversation `GET` responses before ChatGPT stores them in long-lived client state. v0.8 supports both the older mapping response and the current flat `messages[]` API.

For the current `/backend-api/conversations/<id>` API, Turbo now:

- Caps ChatGPT's initial `num_turns` request to **3** instead of the Web client's usual larger request.
- Keeps at most 3 recent user turns within approximately **450 messages / 420 KB** of serialized message data.
- Forces the returned page to report no older page and blocks **automatic** `/messages?before=...` history pagination while Turbo is active, preventing the Web client from immediately loading another large tool-heavy page.
- The toolbar's up-arrow button has a separate manual history path: each explicit click can fetch **5 older turns** using the saved cursor. Only user/assistant text and a tool-call count are retained in a lightweight userscript-owned panel, so those old tool payloads never enter ChatGPT's React/client state.
- Uses a flat-API Deep Turbo threshold of roughly **100 internal messages** or **300 KB** for the newest user turn; an oversized turn keeps that user message plus roughly **80 recent internal messages**.

For the older mapping API, the existing Adaptive/Deep Turbo logic remains: at most 3 recent user turns, approximately 450 path nodes / 700 KB, with Deep Turbo at roughly 260 nodes or 500 KB and a ~120-node tail.

Disable Turbo and reload whenever you need the full older server history in that tab. Server-side conversation data is never deleted or edited.

## Limitations

ChatGPT already performs its own DOM virtualization, so hiding DOM elements alone cannot eliminate every slowdown. Tool-heavy conversations may still accumulate large live React/client state while an Agent continues running after the page has loaded.

Tool Compactor intentionally keeps React-owned nodes intact for compatibility. Turbo only changes what the current page requests/retains locally; it does not edit the server-side conversation. While Turbo is enabled, automatic older-history pagination is intentionally suppressed for performance. The lightweight history panel is text-first: tool payloads are represented only by counts and non-text attachments may be omitted. Disable Turbo and reload when you need ChatGPT's full native history UI.

ChatGPT Web DOM structure and private conversation response formats are not stable public APIs and may require selector or trimming updates in the future.
