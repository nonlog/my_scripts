param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'notify-lib.ps1')

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    [void](Send-AgentNotification -Payload $payload -ConfigPath $ConfigPath)
} catch {
    Write-AgentNotifyLog -Message ("generic adapter failed: " + $_.Exception.Message)
}
exit 0
