[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$SkipCodex,
    [switch]$SkipClaude,
    [switch]$SkipPi
)

$ErrorActionPreference = 'Stop'
$userHome = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($userHome)) { throw 'Cannot resolve the Windows user profile.' }
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $userHome '.agent-hooks\windows-notify'
}

function Backup-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $Path -Destination "$Path.bak-windows-notify-$stamp" -Force
}

function Get-JsonHashtable([string]$Path, $Default) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $Default }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable)
}

function Save-JsonHashtable([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    $null = New-Item -ItemType Directory -Path $parent -Force
    $Value | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Test-HookCommand($Groups, [string]$Command) {
    foreach ($group in @($Groups)) {
        if ($null -eq $group -or -not $group.ContainsKey('hooks')) { continue }
        foreach ($handler in @($group.hooks)) {
            if ($null -eq $handler) { continue }
            if (($handler.ContainsKey('commandWindows') -and [string]$handler.commandWindows -eq $Command) -or
                ($handler.ContainsKey('command') -and [string]$handler.command -eq $Command)) { return $true }
        }
    }
    return $false
}

$null = New-Item -ItemType Directory -Path $InstallRoot -Force
foreach ($name in @('shared', 'adapters')) {
    $source = Join-Path $PSScriptRoot $name
    $dest = Join-Path $InstallRoot $name
    $null = New-Item -ItemType Directory -Path $dest -Force
    Copy-Item -Path (Join-Path $source '*') -Destination $dest -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'notify-config.json') -Destination (Join-Path $InstallRoot 'notify-config.json') -Force

if (-not $SkipCodex) {
    $hooksPath = Join-Path $userHome '.codex\hooks.json'
    $doc = Get-JsonHashtable -Path $hooksPath -Default ([ordered]@{ hooks = [ordered]@{} })
    if (-not $doc.ContainsKey('hooks') -or $null -eq $doc.hooks) { $doc.hooks = [ordered]@{} }
    if (-not $doc.hooks.ContainsKey('Stop')) { $doc.hooks.Stop = @() }
    $command = 'cmd.exe /d /c ' + (Join-Path $InstallRoot 'adapters\codex-stop.cmd')
    if (-not (Test-HookCommand -Groups $doc.hooks.Stop -Command $command)) {
        Backup-File $hooksPath
        $doc.hooks.Stop = @($doc.hooks.Stop) + @([ordered]@{
            hooks = @([ordered]@{
                type = 'command'
                command = $command
                commandWindows = $command
                timeout = 15
            })
        })
        Save-JsonHashtable -Path $hooksPath -Value $doc
    }
}

if (-not $SkipClaude) {
    $settingsPath = Join-Path $userHome '.claude\settings.json'
    $doc = Get-JsonHashtable -Path $settingsPath -Default ([ordered]@{})
    if (-not $doc.ContainsKey('hooks') -or $null -eq $doc.hooks) { $doc.hooks = [ordered]@{} }
    if (-not $doc.hooks.ContainsKey('Stop')) { $doc.hooks.Stop = @() }
    $command = 'cmd.exe /d /c ' + (Join-Path $InstallRoot 'adapters\claude-stop.cmd')
    if (-not (Test-HookCommand -Groups $doc.hooks.Stop -Command $command)) {
        Backup-File $settingsPath
        $doc.hooks.Stop = @($doc.hooks.Stop) + @([ordered]@{
            hooks = @([ordered]@{
                type = 'command'
                command = $command
                timeout = 15
            })
        })
        Save-JsonHashtable -Path $settingsPath -Value $doc
    }
}

if (-not $SkipPi) {
    $piExtensions = Join-Path $userHome '.pi\agent\extensions'
    $null = New-Item -ItemType Directory -Path $piExtensions -Force
    $piTarget = Join-Path $piExtensions 'windows-notify.ts'
    Backup-File $piTarget
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'adapters\pi-windows-notify.ts') -Destination $piTarget -Force
}

Write-Host "Installed shared notifier to: $InstallRoot"
if (-not $SkipCodex) { Write-Host 'Codex: open /hooks once and trust the new Stop hook.' }
if (-not $SkipClaude) { Write-Host 'Claude Code: Stop hook merged into ~/.claude/settings.json.' }
if (-not $SkipPi) { Write-Host 'Pi: extension installed at ~/.pi/agent/extensions/windows-notify.ts.' }
