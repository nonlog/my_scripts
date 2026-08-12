# my_scripts

Personal browser userscripts.

## ChatGPT Recent Turns

`chatgpt-recent-turns.user.js` reduces rendering work in very long ChatGPT Web conversations.

### Behavior

- Shows the latest **10 user turns** by default.
- A turn means one user message plus the assistant/tool messages that follow it.
- When you scroll near the top, it reveals **10 older turns** at a time.
- `旧消息 +10` manually reveals 10 older turns.
- `显示全部` temporarily reveals the entire conversation.
- `重置` returns to the latest 10 turns.
- Does **not** intercept ChatGPT network requests or modify conversation data.

### Installation

1. Install a userscript manager such as Tampermonkey.
2. Create a new userscript.
3. Copy the contents of `chatgpt-recent-turns.user.js` into it and save.
4. Open or reload `https://chatgpt.com/`.

### Limitations

This script hides old conversation DOM elements with `display: none`. It can reduce browser layout/paint work, but it does not stop ChatGPT from downloading or retaining the full conversation state in JavaScript memory.

ChatGPT Web's DOM is not a stable public API. If OpenAI changes message markup, the selectors in this script may need to be updated.
