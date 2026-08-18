# Claude Code Auto Session Title

A `UserPromptSubmit` command hook that sets Claude Code's official `sessionTitle` as soon as an unnamed session receives a prompt.

## Behavior

- Reads the hook's `transcript_path` and finds the first non-meta user prompt, so resumed sessions are named from their original request rather than a later `继续` message.
- Preserves explicit names detected through Claude Code title/name records.
- Generates the title locally with a deterministic sanitizer, so the hook adds essentially no model latency before the main Claude turn.
- Returns only the documented `hookSpecificOutput.sessionTitle` JSON; it never edits transcript or state files.
- Removes URLs and absolute paths and caps titles at 64 characters.
- Fails open: parsing/title errors never reject the user prompt.

## Install

```powershell
python .\install.py
```

The installer copies the hook to `~/.claude/hooks/auto_session_title.py`, merges one `UserPromptSubmit` command hook into `~/.claude/settings.json`, preserves unrelated hooks, and makes a timestamped settings backup.
