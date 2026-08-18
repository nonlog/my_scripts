# Pi Auto Session Title

Global Pi extension that names an unnamed session as soon as the user submits a prompt.

## Behavior

- Uses Pi's `before_agent_start` event, which runs after prompt submission and before the main agent loop.
- Reads the first user message from the current session history, so resuming an old unnamed session and typing `继续` still titles it from the original request.
- Uses Pi's current model through `ctx.modelRegistry.complete()` in the background to generate a short title.
- Applies the result with the official `pi.setSessionName()` API.
- Never overwrites a name already set by `/name` or `--name`.
- Cancels application of a background result if the user switches sessions before generation finishes.
- Falls back to a local sanitized title if the title model call fails.

## Install

Place `auto-session-title.ts` in:

```text
~/.pi/agent/extensions/auto-session-title.ts
```

Pi auto-discovers global extensions from that directory. Existing Pi processes can use `/reload`; new processes load it automatically.
