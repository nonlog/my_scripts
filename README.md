# my_scripts

Personal browser userscripts.

## ChatGPT Recent Messages

`chatgpt-recent-turns.user.js` reduces rendering work in very long ChatGPT Web conversations.

### Behavior

- Shows the latest **5 messages** by default.
- Reveals **5 older messages** at a time when you scroll near the top.
- Uses a compact **vertical icon toolbar** instead of text buttons.
- Hover or focus an icon to see its tooltip.
- UI language follows `navigator.language`: English browser language gets English tooltips; Chinese browser language gets Chinese tooltips.
- The controls let you load older messages, show all / return to recent messages, and reset to the latest 5 messages.
- Does **not** intercept ChatGPT network requests or modify conversation data.

### Installation

1. Install a userscript manager such as Tampermonkey.
2. Create a new userscript.
3. Copy the contents of `chatgpt-recent-turns.user.js` into it and save.
4. Open or reload `https://chatgpt.com/`.

### Limitations

This script hides old conversation DOM elements with `display: none`. It can reduce browser layout/paint work, but it does not stop ChatGPT from downloading or retaining the full conversation state in JavaScript memory.

ChatGPT Web's DOM is not a stable public API. If OpenAI changes message markup, the selectors in this script may need to be updated.
