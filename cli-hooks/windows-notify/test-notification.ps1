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
$json | & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'shared\notify.ps1')
