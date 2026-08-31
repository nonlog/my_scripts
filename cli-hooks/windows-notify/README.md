# Windows notifications for Codex CLI, Claude Code, and Pi

A shared Windows 11 toast notifier with thin adapters for the three coding CLIs used on this workstation.

## Design

- **Codex CLI**: user-level `Stop` hook. Current Codex sends the hook JSON over stdin, including `cwd` and `last_assistant_message`. This deliberately avoids the legacy `notify = [...]` argv payload, which can hit the Windows command-line length limit on long turns.
- **Claude Code**: user-level `Stop` hook. It consumes `last_assistant_message` directly instead of racing the transcript file.
- **Pi**: extension records the last `turn_end` assistant text and sends the notification on `agent_settled`, so retries, compaction recovery, or queued continuation do not trigger a premature toast.
- **Shared layer**: PowerShell/WinRT `ToastNotificationManager`. No PowerShell module is required.

The default AppUserModelID is Windows Terminal:

```text
Microsoft.WindowsTerminal_8wekyb3d8bbwe!App
```

That keeps the notification routed through an installed Windows application identity instead of requiring a custom Start-menu shortcut registration.

## Install

From this directory in PowerShell 7:

```powershell
pwsh -NoProfile -File .\install.ps1
```

The installer is additive and idempotent:

- copies the shared runtime to `~/.agent-hooks/windows-notify`;
- appends one Codex `Stop` matcher group to the existing `~/.codex/hooks.json` without replacing title/tty7/other hooks;
- appends one Claude Code `Stop` matcher group to `~/.claude/settings.json` without replacing existing hooks;
- installs `~/.pi/agent/extensions/windows-notify.ts`;
- creates timestamped backups before modifying an existing config file.

Codex requires a one-time review for changed non-managed hooks. Open `/hooks` and trust the newly added `Stop` hook after installation.

## Windows Codex command workaround

Current Codex has a Windows hook runner bug when `commandWindows` contains embedded quoted paths. The installer therefore uses a space-free install root and configures a quote-free command such as:

```text
cmd.exe /d /c C:\Users\www\.agent-hooks\windows-notify\adapters\codex-stop.cmd
```

The batch wrapper may quote its own script paths safely after Codex has launched it.

## Foreground suppression

By default a toast is suppressed while **Windows Terminal itself is the foreground process**, because the user is already looking at CLI output. Set this to `false` if you want every completion to toast:

```json
{
  "suppressWhenWindowsTerminalForeground": false
}
```

The current implementation cannot reliably map a Windows Terminal HWND back to a specific `WT_SESSION`, so suppression is process-wide rather than tab-specific.

Set `AI_CLI_NOTIFY_FORCE=1` to bypass foreground suppression for testing.

## Configuration

Edit the installed `~/.agent-hooks/windows-notify/notify-config.json` or the repository copy before reinstalling:

```json
{
  "appId": "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
  "maxMessageChars": 420,
  "maxCwdChars": 140,
  "suppressWhenWindowsTerminalForeground": true,
  "showWorkingDirectory": true,
  "logFailures": true
}
```

Failures are best-effort logged to `%LOCALAPPDATA%\AgentHooks\windows-notify.log` and never fail an agent turn.

## Tests

Adapter parsing without a real toast:

```powershell
pwsh -NoProfile -File .\tests\smoke.ps1
```

Force one real toast:

```powershell
pwsh -NoProfile -File .\test-notification.ps1
```

## Event behavior

| CLI | Event | Why |
| --- | --- | --- |
| Codex CLI | `Stop` | Stable stdin payload; avoids legacy argv-size failure |
| Claude Code | `Stop` | Fires when the main agent finishes responding and exposes `last_assistant_message` |
| Pi | `agent_settled` | Fires only after retry/compaction/queued continuation is finished |

Subagents are intentionally not notified in the first version.
