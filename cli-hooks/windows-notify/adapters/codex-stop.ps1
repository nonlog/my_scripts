$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared\notify-lib.ps1')

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $event = $raw | ConvertFrom-Json
    if ([string]$event.hook_event_name -ne 'Stop') { exit 0 }
    $message = [string]$event.last_assistant_message
    if ([string]::IsNullOrWhiteSpace($message)) { exit 0 }
    $payload = [pscustomobject]@{
        source = 'Codex'
        event = 'complete'
        title = 'Codex completed'
        message = $message
        cwd = [string]$event.cwd
        sessionId = [string]$event.session_id
        turnId = [string]$event.turn_id
    }
    [void](Send-AgentNotification -Payload $payload)
} catch {
    Write-AgentNotifyLog -Message ("Codex adapter failed: " + $_.Exception.Message)
}
exit 0
