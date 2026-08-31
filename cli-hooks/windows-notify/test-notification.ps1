$ErrorActionPreference = 'Stop'
$payload = [ordered]@{
    source = 'AI CLI'
    event = 'complete'
    title = 'AI CLI notification test'
    message = 'Windows completion notifications are working.'
    cwd = (Get-Location).Path
    force = $true
}
$json = $payload | ConvertTo-Json -Compress
$json | & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'shared\notify.ps1')
