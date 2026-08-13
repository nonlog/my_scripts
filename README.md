# my_scripts

Personal browser userscripts.

## ChatGPT Recent Messages

`chatgpt-recent-turns.user.js` reduces rendering work, tool-call layout overhead, and client-side conversation-state size in very long ChatGPT Web conversations.

### Behavior

- Shows the latest **5 currently materialized messages** by default.
- Reveals **5 older messages** at a time when you scroll near the top.
- Uses a compact **vertical icon toolbar** with hover/focus tooltips.
- UI language follows the browser's preferred language (`navigator.languages[0]` / `navigator.language`).
- Avoids the previous whole-page MutationObserver feedback loop and periodic URL polling.
- Watches ChatGPT's virtualized conversation list instead of every streaming Markdown mutation.
- Avoids repeated scroll-parent measurements that previously caused forced reflows.

### Tool Compactor

Tool Compactor is enabled by default.

When ChatGPT renders a consecutive run of collapsed `Called tool` rows, the script:

- Keeps the original React-managed tool nodes intact for compatibility.
- Removes those rows from layout/paint with `display: none`.
- Replaces the run with a single lightweight `N tool calls` button.
- Restores the original tool rows when the bundle is clicked.
- Watches each active agent-turn container so newly streamed tool calls are automatically folded into the bundle.
- Can be toggled live with the tools/sliders icon; no reload is required.

v0.4.1 changes streaming compaction from a restore/rebuild cycle to an incremental update. Existing hidden tool rows and bundle buttons are reused; only newly added or genuinely changed nodes receive DOM writes. Tool mutations are also batched for about 180 ms, while toolbar statistics are refreshed separately at a lower frequency.

In a headless-Chrome stress test that appended **300 tool rows one at a time**, the v0.4.0-style restore/rebuild loop produced about **90,896 relevant DOM mutations**. The incremental algorithm produced **301**, a **99.67% reduction**. In the same synthetic test, compaction execution time decreased from about **116 ms to 34 ms** before accounting for the additional layout/paint cost that real ChatGPT pages incur.

In live validation of v0.4.0, a growing run of **22 `Called tool` rows** was reduced to **1 bundle / 0 visible tool rows**. Disabling Tool Compactor restored all 22 original rows immediately.

### Adaptive Turbo mode

Turbo mode is enabled by default and only activates for unusually large conversation responses (at least about **1 MB** of decoded JSON).

It runs at `document-start` in the page context so it can intercept the initial conversation `GET` response before ChatGPT stores the full mapping in long-lived client state.

Instead of always retaining exactly three user turns, v0.4 uses an adaptive whole-turn budget:

- Always keeps the **latest complete user turn**, even when that turn alone is tool-heavy.
- Adds older complete user turns while staying under **3 turns**, about **450 path nodes**, and about **700 KB of serialized retained message data**.
- Never intentionally cuts through the latest user turn's assistant/tool chain.
- Preserves `current_node` and rewires the retained current branch to a valid root.
- Does **not** modify or delete the server-side conversation.
- Does **not** alter message-send (`POST`) requests.

The lightning icon toggles Turbo mode. Changing it reloads the page. Disable Turbo when you need to browse the full older conversation history in the current tab.

One profiled tool-heavy conversation contained about **4.23 MB / 2,086 mapping nodes**. Its latest three user turns still contained **452 internal nodes**, because the newest turn alone contained 192 assistant nodes and 192 tool nodes. The adaptive v0.4 policy could retain the latest complete turn at about **0.69 MB / 386 nodes** in an offline simulation.

On a later live reload of the same workload, the current server response was about **4.40 MB / 2,188 nodes** and adaptive Turbo retained **2 complete turns / 103 nodes**, producing about **0.18 MB** of client-side conversation JSON.

### Controls

- Up arrow: load 5 older materialized messages.
- Lines icon: show all currently materialized messages / return to recent messages.
- Reset icon: return to the latest 5 messages.
- Lightning icon: toggle adaptive Turbo mode and reload.
- Tools/sliders icon: toggle Tool Compactor immediately.

### Installation

1. Install a userscript manager such as ScriptCat or Tampermonkey.
2. Create or update the userscript with the contents of `chatgpt-recent-turns.user.js`.
3. Save it and reload `https://chatgpt.com/`.

### Limitations

ChatGPT already performs its own DOM virtualization, so hiding additional DOM nodes alone cannot solve every long-chat slowdown. Tool-heavy conversations can contain hundreds or thousands of assistant/tool nodes in the conversation mapping even when only a handful of turns are visible.

Tool Compactor intentionally does **not** detach React-owned nodes or delete tool metadata. This makes expansion safer, but hidden tool components still exist in React/client memory. The largest remaining optimization opportunity is selective tool metadata pruning, which is not enabled by default because some metadata is needed for ChatGPT's original tool UI.

Turbo mode intentionally removes older client-side mapping nodes for that page load. Older history can be restored by disabling Turbo and reloading. Sending messages after Turbo trimming depends on ChatGPT Web's private conversation format, which is not a stable public API and may change.

ChatGPT Web's DOM structure and private conversation response format can change without notice. Selectors or trimming logic may need updates after frontend changes.
