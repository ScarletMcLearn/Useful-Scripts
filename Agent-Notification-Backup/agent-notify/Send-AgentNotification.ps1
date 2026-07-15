param(
    [ValidateSet("Claude", "Codex")]
    [string]$Agent = "Claude",

    [ValidateSet("Completed", "Failed", "ActionRequired")]
    [string]$Status = "Completed",

    [string]$Message = "The agent needs your attention.",

    [switch]$UseHookInput,

    [switch]$HookOutput,

    [string]$FocusUri
)

$ErrorActionPreference = "Stop"

$LogFile = Join-Path $env:TEMP "agent-notification-error.log"
$DebugLogFile = Join-Path $env:TEMP "agent-notification-debug.log"
$SessionDirectory = Join-Path $env:TEMP "agent-notify-sessions"

function Write-AgentNotificationError {
    param([Parameter(Mandatory)][string]$ErrorMessage)

    try {
        Add-Content -Path $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'): $ErrorMessage"
    }
    catch {
    }
}

function Write-AgentNotificationDebug {
    param(
        [Parameter(Mandatory)][string]$Stage,
        [hashtable]$Data = @{}
    )

    try {
        $Entry = [ordered]@{
            timestamp = (Get-Date).ToString("o")
            stage = $Stage
            pid = $PID
        }

        foreach ($Key in $Data.Keys) {
            $Entry[$Key] = $Data[$Key]
        }

        Add-Content -Path $DebugLogFile -Value (($Entry | ConvertTo-Json -Compress -Depth 8))
    }
    catch {
    }
}

function Add-WindowFocusType {
    if ("AgentNotificationWindowFocus" -as [type]) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AgentNotificationWindowFocus
{
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const uint ASFW_ANY = 0xFFFFFFFF;

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(uint dwProcessId);
}
'@
}

function Get-ParentProcessId {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        $ProcessInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [int]$ProcessInfo.ParentProcessId
    }
    catch {
        return 0
    }
}

function Get-ProcessChain {
    param([int]$StartProcessId = $PID)

    $Chain = @()
    $CurrentProcessId = $StartProcessId
    $VisitedProcessIds = @{}

    for ($Depth = 0; $Depth -lt 32 -and $CurrentProcessId -gt 0; $Depth++) {
        if ($VisitedProcessIds.ContainsKey($CurrentProcessId)) {
            break
        }

        $VisitedProcessIds[$CurrentProcessId] = $true
        $Process = Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue
        $ParentProcessId = Get-ParentProcessId -ProcessId $CurrentProcessId

        $Chain += [PSCustomObject]@{
            pid = $CurrentProcessId
            name = if ($Process) { $Process.ProcessName } else { $null }
            hwnd = if ($Process) { [long]$Process.MainWindowHandle } else { 0 }
            parentPid = $ParentProcessId
        }

        $CurrentProcessId = $ParentProcessId
    }

    return $Chain
}

function Get-WindowProcessId {
    param([Parameter(Mandatory)][long]$WindowHandle)

    Add-WindowFocusType

    if ($WindowHandle -le 0) {
        return 0
    }

    [uint32]$WindowProcessId = 0
    [AgentNotificationWindowFocus]::GetWindowThreadProcessId([IntPtr]::new($WindowHandle), [ref]$WindowProcessId) | Out-Null
    return [int]$WindowProcessId
}

function New-AgentNotifySessionId {
    param([object]$HookData)

    if (-not [string]::IsNullOrWhiteSpace($env:AGENT_NOTIFY_SESSION_ID)) {
        return $env:AGENT_NOTIFY_SESSION_ID
    }

    foreach ($Name in @("session_id", "conversation_id", "thread_id", "rollout_id")) {
        if ($HookData -and $HookData.PSObject.Properties.Name -contains $Name) {
            $Value = [string]$HookData.$Name
            if (-not [string]::IsNullOrWhiteSpace($Value)) {
                return ($Value -replace '[^A-Za-z0-9_.-]', '_')
            }
        }
    }

    return "$Agent-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
}

function Get-HookMessage {
    param([object]$HookData)

    if (-not $HookData) {
        return $Message
    }

    $PossibleMessages = @(
        $HookData.last_assistant_message,
        $HookData.message,
        $HookData.notification,
        $HookData.reason,
        $HookData.error,
        $HookData.tool_input.description
    )

    foreach ($PossibleMessage in $PossibleMessages) {
        $Output = [string]$PossibleMessage

        if (-not [string]::IsNullOrWhiteSpace($Output)) {
            return $Output
        }
    }

    return $Message
}

function Read-HookData {
    if (-not $UseHookInput) {
        return $null
    }

    try {
        $RawInput = [Console]::In.ReadToEnd()

        if ([string]::IsNullOrWhiteSpace($RawInput)) {
            return $null
        }

        return $RawInput | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-AgentNotificationError ("Hook input could not be read: " + $_.Exception.Message)
        return $null
    }
}

function Get-OriginatingWindow {
    Add-WindowFocusType

    if ($env:AGENT_NOTIFY_HWND -match '^\d+$') {
        $CapturedHandleValue = [long]$env:AGENT_NOTIFY_HWND
        $CapturedHandle = [IntPtr]::new($CapturedHandleValue)

        if ($CapturedHandleValue -gt 0 -and [AgentNotificationWindowFocus]::IsWindow($CapturedHandle)) {
            $CapturedProcessId = Get-WindowProcessId -WindowHandle $CapturedHandleValue

            return [PSCustomObject]@{
                processId = $CapturedProcessId
                processName = $env:AGENT_NOTIFY_TERMINAL_PROCESS
                windowHandle = $CapturedHandleValue
                source = "env"
            }
        }
    }

    $PreferredProcessNames = @(
        "Code",
        "WindowsTerminal",
        "wezterm-gui",
        "alacritty",
        "Tabby",
        "mintty",
        "ConEmu64",
        "ConEmu",
        "Hyper",
        "powershell",
        "pwsh",
        "cmd"
    )

    $FallbackWindow = $null

    foreach ($Item in (Get-ProcessChain -StartProcessId (Get-ParentProcessId -ProcessId $PID))) {
        if ($Item.hwnd -ne 0) {
            $Candidate = [PSCustomObject]@{
                processId = [int]$Item.pid
                processName = [string]$Item.name
                windowHandle = [long]$Item.hwnd
                source = "parent-chain"
            }

            if ($PreferredProcessNames -contains $Item.name) {
                return $Candidate
            }

            if ($null -eq $FallbackWindow) {
                $FallbackWindow = $Candidate
            }
        }
    }

    return $FallbackWindow
}

function Save-AgentNotifySession {
    param(
        [Parameter(Mandatory)][string]$SessionId,
        [object]$OriginatingWindow,
        [string]$ActivationUri,
        [object]$HookData
    )

    New-Item -ItemType Directory -Path $SessionDirectory -Force | Out-Null

    $Session = [ordered]@{
        sessionId = $SessionId
        agent = $Agent
        status = $Status
        hookEvent = if ($HookData -and ($HookData.PSObject.Properties.Name -contains "hook_event_name")) { $HookData.hook_event_name } else { $null }
        currentPid = $PID
        parentPidChain = @(Get-ProcessChain)
        terminalProcessId = if ($OriginatingWindow) { $OriginatingWindow.processId } else { 0 }
        terminalProcessName = if ($OriginatingWindow) { $OriginatingWindow.processName } else { $null }
        hwnd = if ($OriginatingWindow) { $OriginatingWindow.windowHandle } else { 0 }
        windowSource = if ($OriginatingWindow) { $OriginatingWindow.source } else { $null }
        activationUri = $ActivationUri
        createdAt = (Get-Date).ToString("o")
    }

    $SessionPath = Join-Path $SessionDirectory "$SessionId.json"
    $Session | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SessionPath -Encoding UTF8
    return $SessionPath
}

function Get-AgentNotifySession {
    param([Parameter(Mandatory)][string]$SessionId)

    $SessionPath = Join-Path $SessionDirectory "$SessionId.json"

    if (-not (Test-Path -LiteralPath $SessionPath)) {
        return $null
    }

    return Get-Content -LiteralPath $SessionPath -Raw | ConvertFrom-Json -ErrorAction Stop
}

function Invoke-AgentWindowFocusByHandle {
    param(
        [Parameter(Mandatory)][long]$WindowHandle,
        [int]$TargetProcessId = 0
    )

    Add-WindowFocusType

    if ($WindowHandle -le 0) {
        return $false
    }

    $Handle = [IntPtr]::new($WindowHandle)

    if (-not [AgentNotificationWindowFocus]::IsWindow($Handle)) {
        return $false
    }

    $ForegroundHandle = [AgentNotificationWindowFocus]::GetForegroundWindow()
    [uint32]$TargetProcessId = 0
    [uint32]$ForegroundProcessId = 0
    $TargetThreadId = [AgentNotificationWindowFocus]::GetWindowThreadProcessId($Handle, [ref]$TargetProcessId)
    $ForegroundThreadId = [AgentNotificationWindowFocus]::GetWindowThreadProcessId($ForegroundHandle, [ref]$ForegroundProcessId)
    $CurrentThreadId = [AgentNotificationWindowFocus]::GetCurrentThreadId()

    [AgentNotificationWindowFocus]::AllowSetForegroundWindow([AgentNotificationWindowFocus]::ASFW_ANY) | Out-Null

    $AttachedToTarget = $false
    $AttachedToForeground = $false

    try {
        if ($TargetThreadId -ne 0 -and $TargetThreadId -ne $CurrentThreadId) {
            $AttachedToTarget = [AgentNotificationWindowFocus]::AttachThreadInput($CurrentThreadId, $TargetThreadId, $true)
        }

        if ($ForegroundThreadId -ne 0 -and $ForegroundThreadId -ne $CurrentThreadId -and $ForegroundThreadId -ne $TargetThreadId) {
            $AttachedToForeground = [AgentNotificationWindowFocus]::AttachThreadInput($CurrentThreadId, $ForegroundThreadId, $true)
        }

        if ([AgentNotificationWindowFocus]::IsIconic($Handle)) {
            [AgentNotificationWindowFocus]::ShowWindowAsync($Handle, [AgentNotificationWindowFocus]::SW_RESTORE) | Out-Null
        }
        else {
            [AgentNotificationWindowFocus]::ShowWindowAsync($Handle, [AgentNotificationWindowFocus]::SW_SHOW) | Out-Null
        }

        [AgentNotificationWindowFocus]::BringWindowToTop($Handle) | Out-Null
        [AgentNotificationWindowFocus]::SetActiveWindow($Handle) | Out-Null
        $SetForegroundResult = [AgentNotificationWindowFocus]::SetForegroundWindow($Handle)

        if (-not $SetForegroundResult) {
            [AgentNotificationWindowFocus]::SwitchToThisWindow($Handle, $true)
        }

        Start-Sleep -Milliseconds 100
        $ForegroundAfter = [AgentNotificationWindowFocus]::GetForegroundWindow()
        $Focused = ($SetForegroundResult -or $ForegroundAfter.ToInt64() -eq $Handle.ToInt64())

        if (-not $Focused -and $TargetProcessId -gt 0) {
            try {
                $Shell = New-Object -ComObject WScript.Shell
                $Focused = [bool]$Shell.AppActivate($TargetProcessId)
            }
            catch {
                $Focused = $false
            }
        }

        Start-Sleep -Milliseconds 100
        $ForegroundAfter = [AgentNotificationWindowFocus]::GetForegroundWindow()
        return ($Focused -or $ForegroundAfter.ToInt64() -eq $Handle.ToInt64())
    }
    finally {
        if ($AttachedToForeground) {
            [AgentNotificationWindowFocus]::AttachThreadInput($CurrentThreadId, $ForegroundThreadId, $false) | Out-Null
        }

        if ($AttachedToTarget) {
            [AgentNotificationWindowFocus]::AttachThreadInput($CurrentThreadId, $TargetThreadId, $false) | Out-Null
        }
    }
}

function Invoke-AgentWindowFocus {
    param([Parameter(Mandatory)][string]$Uri)

    try {
        $ParsedUri = [Uri]$Uri

        if ($ParsedUri.Scheme -ne "agentnotify" -or $ParsedUri.Host -ne "focus") {
            throw "Invalid agent notification URI: $Uri"
        }

        $SessionId = [Uri]::UnescapeDataString(($ParsedUri.AbsolutePath.Trim("/") -split "/")[0])

        if ([string]::IsNullOrWhiteSpace($SessionId)) {
            throw "Missing session id in agent notification URI: $Uri"
        }

        $Session = Get-AgentNotifySession -SessionId $SessionId

        if (-not $Session) {
            throw "Session file not found for $SessionId"
        }

        $FocusResult = Invoke-AgentWindowFocusByHandle -WindowHandle ([long]$Session.hwnd) -TargetProcessId ([int]$Session.terminalProcessId)

        Write-AgentNotificationDebug "protocol-focus" @{
            sessionId = $SessionId
            protocolInvocation = $Uri
            agent = $Session.agent
            status = $Session.status
            terminalProcessId = $Session.terminalProcessId
            hwnd = $Session.hwnd
            focusResult = $FocusResult
        }
    }
    catch {
        Write-AgentNotificationError $_.Exception.Message
        Write-AgentNotificationDebug "protocol-focus-error" @{
            protocolInvocation = $Uri
            error = $_.Exception.Message
        }
    }
}

function Register-AgentNotificationProtocol {
    try {
        if ([string]::IsNullOrWhiteSpace($PSCommandPath)) {
            throw "The current notification script path could not be determined."
        }

        $PowerShellPath = (Get-Process -Id $PID).Path

        if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
            $PowerShellPath = (Get-Command pwsh.exe).Source
        }

        $ProtocolRoot = "HKCU:\Software\Classes\agentnotify"
        $CommandPath = Join-Path $ProtocolRoot "shell\open\command"
        $ProtocolCommand = "`"$PowerShellPath`" -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -FocusUri `"%1`""
        $ExistingCommand = $null

        try {
            $ExistingCommand = (Get-Item -Path $CommandPath -ErrorAction Stop).GetValue("")
        }
        catch {
            $ExistingCommand = $null
        }

        if ($ExistingCommand -eq $ProtocolCommand) {
            return
        }

        New-Item -Path $ProtocolRoot -Force | Out-Null
        Set-Item -Path $ProtocolRoot -Value "URL:Agent Notification Protocol"
        New-ItemProperty -Path $ProtocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
        New-Item -Path $CommandPath -Force | Out-Null
        Set-Item -Path $CommandPath -Value $ProtocolCommand
    }
    catch {
        Write-AgentNotificationError ("Protocol registration failed: " + $_.Exception.Message)
    }
}

function Write-HookOutput {
    if ($HookOutput) {
        [Console]::Out.WriteLine("{}")
    }
}

if (-not [string]::IsNullOrWhiteSpace($FocusUri)) {
    Invoke-AgentWindowFocus -Uri $FocusUri
    exit 0
}

$HookData = Read-HookData
$SessionId = New-AgentNotifySessionId -HookData $HookData
$Message = Get-HookMessage -HookData $HookData
$Message = ($Message -replace "[\r\n\t]+", " " -replace "\s{2,}", " ").Trim()

if ($Message.Length -gt 350) {
    $Message = $Message.Substring(0, 347) + "..."
}

$Title = switch ($Status) {
    "Completed" { "$Agent - Completed" }
    "Failed" { "$Agent - Failed" }
    "ActionRequired" { "$Agent - Action required" }
}

try {
    Add-Type -AssemblyName System.Windows.Extensions -ErrorAction SilentlyContinue

    switch ($Status) {
        "Completed" { [System.Media.SystemSounds]::Asterisk.Play() }
        "Failed" { [System.Media.SystemSounds]::Hand.Play() }
        "ActionRequired" { [System.Media.SystemSounds]::Exclamation.Play() }
    }
}
catch {
    Write-AgentNotificationError ("Notification sound failed: " + $_.Exception.Message)
}

try {
    Import-Module BurntToast -ErrorAction Stop

    Register-AgentNotificationProtocol

    $OriginatingWindow = Get-OriginatingWindow
    $ActivationUri = "agentnotify://focus/$([Uri]::EscapeDataString($SessionId))"
    $SessionPath = Save-AgentNotifySession -SessionId $SessionId -OriginatingWindow $OriginatingWindow -ActivationUri $ActivationUri -HookData $HookData

    Write-AgentNotificationDebug "notify" @{
        agent = $Agent
        status = $Status
        hookEvent = if ($HookData -and ($HookData.PSObject.Properties.Name -contains "hook_event_name")) { $HookData.hook_event_name } else { $null }
        sessionId = $SessionId
        sessionPath = $SessionPath
        parentPidChain = @(Get-ProcessChain)
        detectedTerminalPid = if ($OriginatingWindow) { $OriginatingWindow.processId } else { 0 }
        detectedHwnd = if ($OriginatingWindow) { $OriginatingWindow.windowHandle } else { 0 }
        activationUri = $ActivationUri
    }

    $TitleText = New-BTText -Content $Title
    $MessageText = New-BTText -Content $Message
    $Binding = New-BTBinding -Children $TitleText, $MessageText
    $Visual = New-BTVisual -BindingGeneric $Binding
    $Audio = New-BTAudio -Silent
    $Content = New-BTContent -Visual $Visual -Audio $Audio -Launch $ActivationUri -ActivationType Protocol
    $UniqueIdentifier = "$Agent-$Status-$SessionId-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

    Submit-BTNotification -Content $Content -UniqueIdentifier $UniqueIdentifier
    Write-HookOutput
}
catch {
    Write-AgentNotificationError ("Clickable notification failed: " + $_.Exception.Message)

    try {
        Import-Module BurntToast -ErrorAction Stop

        $FallbackButton = New-BTButton -Content "Open terminal" -Arguments $ActivationUri -ActivationType Protocol
        New-BurntToastNotification -Text $Title, $Message -Button $FallbackButton -Silent
        Write-HookOutput
    }
    catch {
        Write-AgentNotificationError ("Fallback notification failed: " + $_.Exception.Message)
        Write-HookOutput
    }
}
