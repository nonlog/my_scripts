# Pi Auto Session Title

> Retired local implementation: use the community `furbyhaxx/pi-session-naming` extension instead of copying a custom extension into `~/.pi/agent/extensions/`.

## Current recommendation

Install the community extension:

```powershell
pi install git:https://github.com/furbyhaxx/pi-session-naming
```

The extension uses Pi-native session APIs, including `pi.setSessionName()`, preserves manual names, and also provides `/rename` and `/sessions` workflows.

Validated with **Pi 0.84.2** on 2026-08-19.

For the local model catalog used in this setup, the following global configuration keeps title generation lightweight and produces plain description-style titles:

```json
{
  "session": {
    "titleGeneration": {
      "enabled": true,
      "language": "auto",
      "model": "www/deepseek-v4-flash:minimal",
      "retries": 2,
      "emojis": false,
      "maxLength": 64,
      "useTags": false
    }
  }
}
```

Put the configuration in:

```text
~/.pi/agent/settings.json
```

If your Pi installation does not have the `www/deepseek-v4-flash` model, either choose another lightweight model from your own model registry or leave `model` as `auto`.

## Migration from the old extension

Remove the old repository-provided file if present:

```text
~/.pi/agent/extensions/auto-session-title.ts
```

Then install `pi-session-naming` with `pi install` as shown above. Existing explicit session names remain authoritative.
