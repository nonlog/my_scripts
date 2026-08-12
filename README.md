# my_scripts

Personal browser userscripts.

## ChatGPT Recent Messages

`chatgpt-recent-turns.user.js` reduces both rendering work and client-side conversation-state overhead in very long ChatGPT Web conversations.

### Behavior

- Shows the latest **5 currently materialized messages** by default.
- Reveals **5 older messages** at a time when you scroll near the top.
- Uses a compact **vertical icon toolbar** with hover/focus tooltips.
- UI language follows the browser's preferred language (`navigator.languages[0]` / `navigator.language`).
- Removes the previous whole-page MutationObserver feedback loop and 500 ms URL polling.
- Watches ChatGPT's own virtualized conversation list instead of streaming Markdown/tool DOM changes.
- Avoids repeated scroll-parent layout measurements that previously caused forced reflows.

### Turbo mode

Turbo mode is enabled by default and only activates for unusually large conversation responses (at least about **1 MB** of decoded JSON).

When active it:

- Runs at `document-start` in the page context so it can intercept the initial conversation `GET` response before ChatGPT stores the full mapping in long-lived client state.
- Keeps the current branch's latest **3 user turns** and all assistant/tool nodes belonging to those retained turns.
- Preserves the current node and rewires the retained mapping to a valid root.
- Does **not** modify or delete the server-side conversation.
- Does **not** alter message-send (`POST`) requests.

The lightning icon toggles Turbo mode. Changing it reloads the page. Disable Turbo when you need to browse the full older conversation history in the current tab.

For one profiled tool-heavy conversation, ChatGPT returned about **2.24 MB / 880 mapping nodes** even though only 8 turn elements were materialized in the DOM. Retaining the latest 3 user turns reduced that mapping to about **1.02 MB / 420 nodes** before ChatGPT consumed it.

### Controls

- Up arrow: load 5 older materialized messages.
- Lines icon: show all currently materialized messages / return to recent messages.
- Reset icon: return to the latest 5 messages.
- Lightning icon: toggle Turbo mode and reload.

### Installation

1. Install a userscript manager such as Tampermonkey.
2. Create or update the userscript with the contents of `chatgpt-recent-turns.user.js`.
3. Save it and reload `https://chatgpt.com/`.

### Limitations

ChatGPT already performs its own DOM virtualization, so hiding additional DOM nodes alone cannot solve every long-chat slowdown. Tool-heavy conversations can contain hundreds of assistant/tool nodes in the conversation mapping even when only a handful of turns are visible.

Turbo mode intentionally removes older client-side mapping nodes for that page load. Older history can be restored by disabling Turbo and reloading. Sending a new message after Turbo trimming still needs real-world validation across ChatGPT updates, because ChatGPT Web's internal conversation format is not a stable public API.

ChatGPT Web's DOM structure and private conversation response format can change without notice. Selectors or trimming logic may need updates after frontend changes.
