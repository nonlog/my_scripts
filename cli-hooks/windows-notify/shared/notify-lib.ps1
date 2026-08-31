Set-StrictMode -Version Latest

function Get-AgentNotifyConfig {
    param([string]$ConfigPath)

    $defaults = [ordered]@{
        appId = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App'
        maxMessageChars = 420
        maxCwdChars = 140
        suppressWhenWindowsTerminalForeground = $true
        showWorkingDirectory = $true
        logFailures = $true
    }

    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        $ConfigPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'notify-config.json'
    }

    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        try {
            $custom = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            foreach ($property in $custom.PSObject.Properties) {
                $defaults[$property.Name] = $property.Value
            }
        } catch {
            # Invalid optional config must never break a CLI completion hook.
        }
    }

    return [pscustomobject]$defaults
}

function Write-AgentNotifyLog {
    param(
        [Parameter(Mandatory)] [string]$Message,
        [bool]$Enabled = $true
    )

    if (-not $Enabled) { return }
    try {
        $local = [Environment]::GetFolderPath('LocalApplicationData')
        if ([string]::IsNullOrWhiteSpace($local)) { return }
        $dir = Join-Path $local 'AgentHooks'
        $null = New-Item -ItemType Directory -Path $dir -Force
        $line = '{0:o} {1}' -f [DateTimeOffset]::Now, $Message
        Add-Content -LiteralPath (Join-Path $dir 'windows-notify.log') -Value $line -Encoding utf8
    } catch {
        # Logging is best effort only.
    }
}

function Get-AgentNotifyForegroundProcessName {
    try {
        if (-not ('AgentHooksForegroundWindow' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentHooksForegroundWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
        }
        $handle = [AgentHooksForegroundWindow]::GetForegroundWindow()
        if ($handle -eq [IntPtr]::Zero) { return '' }
        [uint32]$foregroundPid = 0
        $null = [AgentHooksForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$foregroundPid)
        if ($foregroundPid -eq 0) { return '' }
        return (Get-Process -Id $foregroundPid -ErrorAction Stop).ProcessName
    } catch {
        return ''
    }
}

function Limit-AgentNotifyText {
    param(
        [AllowNull()] [string]$Text,
        [int]$MaxChars
    )

    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $normalized = $Text -replace "`r`n", "`n" -replace "`r", "`n"
    $normalized = ($normalized -split "`n" | ForEach-Object { $_.TrimEnd() }) -join "`n"
    $normalized = $normalized.Trim()
    if ($MaxChars -gt 0 -and $normalized.Length -gt $MaxChars) {
        if ($MaxChars -le 1) { return $normalized.Substring(0, $MaxChars) }
        return $normalized.Substring(0, $MaxChars - 1).TrimEnd() + [char]0x2026
    }
    return $normalized
}

function Write-AgentNotifyTestSnapshot {
    param([Parameter(Mandatory)]$Snapshot)
    $target = $env:AI_CLI_NOTIFY_TEST_OUTPUT
    if ([string]::IsNullOrWhiteSpace($target)) { return }
    try {
        $parent = Split-Path -Parent $target
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
            $null = New-Item -ItemType Directory -Path $parent -Force
        }
        $Snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $target -Encoding utf8
    } catch {
        # Tests should fail on missing/incorrect output, not hook execution.
    }
}

function Send-AgentNotification {
    param(
        [Parameter(Mandatory)]$Payload,
        [string]$ConfigPath
    )

    $config = Get-AgentNotifyConfig -ConfigPath $ConfigPath
    try {
        $source = Limit-AgentNotifyText -Text ([string]$Payload.source) -MaxChars 80
        if ([string]::IsNullOrWhiteSpace($source)) { $source = 'AI CLI' }
        $eventName = Limit-AgentNotifyText -Text ([string]$Payload.event) -MaxChars 40
        if ([string]::IsNullOrWhiteSpace($eventName)) { $eventName = 'complete' }
        $title = Limit-AgentNotifyText -Text ([string]$Payload.title) -MaxChars 120
        if ([string]::IsNullOrWhiteSpace($title)) {
            $suffix = if ($eventName -eq 'failed') { 'failed' } else { 'completed' }
            $title = "$source $suffix"
        }
        $message = Limit-AgentNotifyText -Text ([string]$Payload.message) -MaxChars ([int]$config.maxMessageChars)
        if ([string]::IsNullOrWhiteSpace($message)) { return $false }
        $cwd = Limit-AgentNotifyText -Text ([string]$Payload.cwd) -MaxChars ([int]$config.maxCwdChars)

        $force = $false
        if ($null -ne $Payload.PSObject.Properties['force']) { $force = [bool]$Payload.force }
        if ($env:AI_CLI_NOTIFY_FORCE -eq '1') { $force = $true }

        $foreground = Get-AgentNotifyForegroundProcessName
        $suppressed = (-not $force) -and [bool]$config.suppressWhenWindowsTerminalForeground -and ($foreground -in @('WindowsTerminal', 'wt'))

        $snapshot = [pscustomobject]@{
            source = $source
            event = $eventName
            title = $title
            message = $message
            cwd = $cwd
            foregroundProcess = $foreground
            suppressed = $suppressed
        }

        if ($env:AI_CLI_NOTIFY_DRY_RUN -eq '1') {
            Write-AgentNotifyTestSnapshot -Snapshot $snapshot
            return $true
        }
        if ($suppressed) { return $true }

        $escape = { param([string]$Value) [Security.SecurityElement]::Escape($Value) }
        $titleXml = & $escape $title
        $messageXml = & $escape $message
        $cwdXml = & $escape $cwd
        $parts = @("<text>$titleXml</text>", "<text>$messageXml</text>")
        if ([bool]$config.showWorkingDirectory -and -not [string]::IsNullOrWhiteSpace($cwdXml)) {
            $parts += "<text placement=`"attribution`">$cwdXml</text>"
        }
        $toastXml = '<toast><visual><binding template="ToastGeneric">' + ($parts -join '') + '</binding></visual></toast>'

        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($toastXml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$config.appId)
        $notifier.Show($toast)
        return $true
    } catch {
        Write-AgentNotifyLog -Message ("notification failed: " + $_.Exception.Message) -Enabled ([bool]$config.logFailures)
        return $false
    }
}
