# Codex Auto Thread Title

A small Codex `Stop` hook that automatically gives newly created **Codex CLI** conversations a useful title after the first completed turn.

It deliberately does **not** edit `state_*.sqlite`, rollout JSONL files, or other Codex state files directly. Thread inspection and renaming go through Codex app-server APIs.

## Behavior

On each `Stop` event the hook launcher exits quickly after starting a detached worker. The worker then checks whether the thread still needs a title. For an eligible thread it:

1. Reads the thread through `thread/read`.
2. Requires `thread.source == "cli"`, so Desktop/app-server/exec threads are ignored.
3. Refuses to overwrite a non-empty thread name. Manual `/rename` always wins.
4. Uses the thread preview (normally the first user request) to generate a short title with an **ephemeral** `codex exec` child.
5. Reads the thread again before writing, so a manual rename performed while title generation is running is preserved.
6. Sets the title through `thread/name/set`.
7. Records a small processed marker so later turns do not rename the thread again.

The Codex hook itself is synchronous but intentionally tiny: it only starts a detached background worker and returns immediately. This works with Codex builds that currently skip `async` hooks. The background worker does the app-server lookup and title generation. If generation fails, it uses a conservative local fallback based on the first request. Operational errors never block the Codex turn and are retried on a later `Stop` event.

## Safety properties

- No direct SQLite writes.
- No direct rollout/transcript edits.
- Only threads whose app-server source is `cli` are auto-named.
- Existing names are never overwritten.
- A second name check closes the manual-rename race.
- A per-session lock prevents duplicate concurrent `Stop` workers.
- The title-generation child sets `CODEX_AUTO_TITLE_CHILD=1` so its own `Stop` hook exits immediately and cannot recurse.
- Logs contain session IDs and status/error classes, but not prompt text or generated titles.

## Requirements

- A recent Codex CLI with Hooks support.
- `codex app-server` support for `thread/read` and `thread/name/set`.
- No Codex async-hook support is required; the hook launcher detaches its own worker.
- Python 3.10+.
- The same Codex authentication/model-provider configuration that your normal CLI uses.

## Install

From this directory:

```powershell
python .\install.py
```

The installer:

- copies `auto_thread_title.py` to `~/.codex/hooks/auto-thread-title/`;
- merges one short synchronous `Stop` launcher into `~/.codex/hooks.json`; the launcher immediately detaches the real worker;
- makes a timestamped backup before changing an existing `hooks.json`;
- preserves all unrelated hooks.

Restart Codex after installation. If Codex asks you to review/trust the newly discovered hook, open `/hooks` and approve it after reviewing the command.

Uninstall only this hook:

```powershell
python .\install.py --uninstall
```

Uninstall preserves the hook's state/log directory so it does not accidentally erase diagnostics.

## Configuration

All settings are optional environment variables inherited by Codex:

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX_AUTO_TITLE_MODEL` | current turn model | Override the model used to generate titles |
| `CODEX_AUTO_TITLE_PROVIDER` | thread model provider | Override the model provider |
| `CODEX_AUTO_TITLE_MAX_CHARS` | `64` | Maximum title length; clamped to 24-120 |
| `CODEX_AUTO_TITLE_GENERATION_TIMEOUT` | `90` | Child generation timeout in seconds; clamped to 15-300 |
| `CODEX_AUTO_TITLE_CODEX` | `codex` on `PATH` | Explicit Codex executable |
| `CODEX_AUTO_TITLE_STATE_DIR` | `~/.codex/auto-thread-title` | State/log directory |

Processed markers live under `processed/`, locks under `locks/`, and operational events in `events.jsonl`.

## Hook configuration produced by the installer

Conceptually the installer adds this group to `hooks.Stop` (the real command contains absolute paths):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/auto_thread_title.py",
            "commandWindows": "python.exe C:\\path\\to\\auto_thread_title.py",
            "timeout": 10,
            "statusMessage": "Starting CLI auto-title worker..."
          }
        ]
      }
    ]
  }
}
```

## Why `Stop` instead of `SessionStart`

`SessionStart` occurs before there is enough conversation content to make a good title, and its hook source describes lifecycle state such as startup/resume rather than reliably identifying the UI that created the thread. `Stop` provides the thread ID after a completed turn; the detached worker then asks app-server for authoritative thread metadata, including the actual session source and current name.
