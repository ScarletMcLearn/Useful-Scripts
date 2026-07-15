function Add-AgentNotifyCaptureType {
    if ("AgentNotifyCapture" -as [type]) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AgentNotifyCapture
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
}

function Get-AgentNotifyForegroundWindow {
    try {
        Add-AgentNotifyCaptureType

        $Handle = [AgentNotifyCapture]::GetForegroundWindow()

        if ($Handle -eq [IntPtr]::Zero) {
            return $null
        }

        [uint32]$ProcessId = 0
        [AgentNotifyCapture]::GetWindowThreadProcessId($Handle, [ref]$ProcessId) | Out-Null
        $Process = Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue

        [PSCustomObject]@{
            Hwnd = [long]$Handle
            ProcessId = [int]$ProcessId
            ProcessName = if ($Process) { $Process.ProcessName } else { $null }
        }
    }
    catch {
        $null
    }
}

function Invoke-AgentNotifyCommand {
    param(
        [Parameter(Mandatory)][ValidateSet("Claude", "Codex")]
        [string]$Agent,

        [Parameter(Mandatory)]
        [string]$ApplicationName,

        [Parameter(ValueFromRemainingArguments)]
        [string[]]$ArgumentList
    )

    $Command = @(Get-Command -Name "$ApplicationName.exe" -CommandType Application -ErrorAction SilentlyContinue) |
        Select-Object -First 1

    if (-not $Command) {
        $Command = @(Get-Command -Name $ApplicationName -CommandType Application -ErrorAction Stop) |
            Select-Object -First 1
    }

    $Window = Get-AgentNotifyForegroundWindow
    $SessionId = [guid]::NewGuid().ToString()

    $OldSessionId = $env:AGENT_NOTIFY_SESSION_ID
    $OldHwnd = $env:AGENT_NOTIFY_HWND
    $OldTerminalPid = $env:AGENT_NOTIFY_TERMINAL_PID
    $OldTerminalProcess = $env:AGENT_NOTIFY_TERMINAL_PROCESS
    $OldLauncherPid = $env:AGENT_NOTIFY_LAUNCHER_PID
    $OldAgent = $env:AGENT_NOTIFY_AGENT

    try {
        $env:AGENT_NOTIFY_SESSION_ID = $SessionId
        $env:AGENT_NOTIFY_LAUNCHER_PID = [string]$PID
        $env:AGENT_NOTIFY_AGENT = $Agent

        if ($Window) {
            $env:AGENT_NOTIFY_HWND = [string]$Window.Hwnd
            $env:AGENT_NOTIFY_TERMINAL_PID = [string]$Window.ProcessId
            $env:AGENT_NOTIFY_TERMINAL_PROCESS = [string]$Window.ProcessName
        }
        else {
            Remove-Item Env:\AGENT_NOTIFY_HWND -ErrorAction SilentlyContinue
            Remove-Item Env:\AGENT_NOTIFY_TERMINAL_PID -ErrorAction SilentlyContinue
            Remove-Item Env:\AGENT_NOTIFY_TERMINAL_PROCESS -ErrorAction SilentlyContinue
        }

        & $Command.Source @ArgumentList
    }
    finally {
        if ($null -ne $OldSessionId) { $env:AGENT_NOTIFY_SESSION_ID = $OldSessionId } else { Remove-Item Env:\AGENT_NOTIFY_SESSION_ID -ErrorAction SilentlyContinue }
        if ($null -ne $OldHwnd) { $env:AGENT_NOTIFY_HWND = $OldHwnd } else { Remove-Item Env:\AGENT_NOTIFY_HWND -ErrorAction SilentlyContinue }
        if ($null -ne $OldTerminalPid) { $env:AGENT_NOTIFY_TERMINAL_PID = $OldTerminalPid } else { Remove-Item Env:\AGENT_NOTIFY_TERMINAL_PID -ErrorAction SilentlyContinue }
        if ($null -ne $OldTerminalProcess) { $env:AGENT_NOTIFY_TERMINAL_PROCESS = $OldTerminalProcess } else { Remove-Item Env:\AGENT_NOTIFY_TERMINAL_PROCESS -ErrorAction SilentlyContinue }
        if ($null -ne $OldLauncherPid) { $env:AGENT_NOTIFY_LAUNCHER_PID = $OldLauncherPid } else { Remove-Item Env:\AGENT_NOTIFY_LAUNCHER_PID -ErrorAction SilentlyContinue }
        if ($null -ne $OldAgent) { $env:AGENT_NOTIFY_AGENT = $OldAgent } else { Remove-Item Env:\AGENT_NOTIFY_AGENT -ErrorAction SilentlyContinue }
    }
}

function claude {
    Invoke-AgentNotifyCommand -Agent Claude -ApplicationName claude -ArgumentList $args
}

function codex {
    Invoke-AgentNotifyCommand -Agent Codex -ApplicationName codex -ArgumentList $args
}

function claude-mt {
    $OldClaudeConfigDir = $env:CLAUDE_CONFIG_DIR

    try {
        $env:CLAUDE_CONFIG_DIR = "$HOME\.claude-mt"
        claude @args
    }
    finally {
        if ($null -ne $OldClaudeConfigDir) { $env:CLAUDE_CONFIG_DIR = $OldClaudeConfigDir } else { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
    }
}

function claude-personal {
    $OldClaudeConfigDir = $env:CLAUDE_CONFIG_DIR

    try {
        $env:CLAUDE_CONFIG_DIR = "$HOME\.claude-personal"
        claude @args
    }
    finally {
        if ($null -ne $OldClaudeConfigDir) { $env:CLAUDE_CONFIG_DIR = $OldClaudeConfigDir } else { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
    }
}
