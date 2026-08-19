# Claude Code Auto Session Title

> Retired: Claude Code now has a built-in AI auto-title path, so this repository no longer installs or maintains a custom session-title hook.

## Current recommendation

Use Claude Code's native conversation auto-title behavior. No extra hook or script is required.

Validated with **Claude Code 2.1.235** on 2026-08-19:

- a new interactive session automatically received a generated title;
- the transcript persisted the result as an `ai-title` record;
- manual `/rename` remains available when an explicit name is preferred.

The previously shipped `UserPromptSubmit -> auto_session_title.py -> hookSpecificOutput.sessionTitle` implementation was useful before native AI titles were available, but keeping it now would duplicate built-in behavior and require unnecessary local maintenance.

## Migration from the old hook

If the old version from this repository was installed, remove its `UserPromptSubmit` entry from `~/.claude/settings.json` and delete:

```text
~/.claude/hooks/auto_session_title.py
```

Preserve unrelated `UserPromptSubmit` hooks.

After migration, start a normal interactive Claude Code session and submit a substantive first prompt. Claude Code should generate the conversation title itself.
