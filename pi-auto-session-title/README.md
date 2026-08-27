# Pi Auto Session Title

The previous community `furbyhaxx/pi-session-naming` recommendation has been replaced by the dedicated [`nonlog/pi-auto-session-title`](https://github.com/nonlog/pi-auto-session-title) extension.

## Current recommendation

Install:

```powershell
pi install git:https://github.com/nonlog/pi-auto-session-title
```

The extension uses Pi-native APIs:

```text
before_agent_start
-> ctx.modelRegistry.complete()
-> pi.setSessionName()
```

It preserves manual names, re-checks session/name state after title generation, ignores trivial first prompts such as `继续` or `continue`, supports `/retitle`, and falls back to a sanitized local title if the model errors, returns empty output, or times out.

Validated with **Pi 0.84.3** on 2026-08-27.

Current configuration:

```json
{
  "session": {
    "titleGeneration": {
      "enabled": true,
      "model": "www/gpt-5.6-luna:minimal",
      "retries": 2,
      "maxLength": 64,
      "timeoutMs": 12000
    }
  }
}
```

`www/deepseek-v4-flash:minimal` was previously used for title generation, but real-session testing showed that request path could hang. `www/gpt-5.6-luna:minimal` was verified end-to-end to generate and persist session titles reliably.

## Migration

Remove the old community extension if installed:

```powershell
pi remove git:https://github.com/furbyhaxx/pi-session-naming
```

Then install the dedicated extension as shown above. Existing explicit session names remain authoritative.
