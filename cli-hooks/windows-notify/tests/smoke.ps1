$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$temp = Join-Path ([IO.Path]::GetTempPath()) ('agent-notify-' + [guid]::NewGuid().ToString('N') + '.json')
$env:AI_CLI_NOTIFY_DRY_RUN = '1'
$env:AI_CLI_NOTIFY_FORCE = '1'
$env:AI_CLI_NOTIFY_TEST_OUTPUT = $temp
try {
    $codex = @{ hook_event_name='Stop'; session_id='s1'; turn_id='t1'; cwd='C:\work\codex'; last_assistant_message='Codex done' } | ConvertTo-Json -Compress
    $codex | & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'adapters\codex-stop.ps1')
    $result = Get-Content -LiteralPath $temp -Raw | ConvertFrom-Json
    if ($result.source -ne 'Codex' -or $result.message -ne 'Codex done' -or $result.cwd -ne 'C:\work\codex') { throw 'Codex adapter smoke test failed.' }

    Remove-Item -LiteralPath $temp -Force
    $claude = @{ hook_event_name='Stop'; session_id='s2'; cwd='C:\work\claude'; last_assistant_message='Claude done' } | ConvertTo-Json -Compress
    $claude | & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'adapters\claude-stop.ps1')
    $result = Get-Content -LiteralPath $temp -Raw | ConvertFrom-Json
    if ($result.source -ne 'Claude Code' -or $result.message -ne 'Claude done' -or $result.cwd -ne 'C:\work\claude') { throw 'Claude adapter smoke test failed.' }

    Write-Host 'Windows notify adapter smoke tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:AI_CLI_NOTIFY_DRY_RUN -ErrorAction SilentlyContinue
    Remove-Item Env:AI_CLI_NOTIFY_FORCE -ErrorAction SilentlyContinue
    Remove-Item Env:AI_CLI_NOTIFY_TEST_OUTPUT -ErrorAction SilentlyContinue
}
