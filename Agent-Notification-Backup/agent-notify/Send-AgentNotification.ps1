param(
    [ValidateSet("Claude", "Codex")]
    [string]$Agent = "Claude",

    [ValidateSet("Completed", "Failed", "ActionRequired")]
    [string]$Status = "Completed",

    [string]$Message = "The agent needs your attention.",

    [switch]$UseHookInput,

    [switch]$HookOutput
)

if ($UseHookInput) {
    try {
        $rawInput = [Console]::In.ReadToEnd()

        if (-not [string]::IsNullOrWhiteSpace($rawInput)) {
            $hookData = $rawInput | ConvertFrom-Json -ErrorAction Stop
            $output = [string]$hookData.last_assistant_message

            if (-not [string]::IsNullOrWhiteSpace($output)) {
                $Message = $output
            }
        }
    }
    catch {
        $Message = "$Agent finished, but its output could not be read."
    }
}

$Message = ($Message -replace "[\r\n\t]+", " " -replace "\s{2,}", " ").Trim()

if ($Message.Length -gt 350) {
    $Message = $Message.Substring(0, 347) + "..."
}

$Title = switch ($Status) {
    "Completed"      { "$Agent — Completed" }
    "Failed"         { "$Agent — Failed" }
    "ActionRequired" { "$Agent — Action required" }
}

try {
    Add-Type -AssemblyName System.Windows.Extensions -ErrorAction SilentlyContinue

    switch ($Status) {
        "Completed" {
            [System.Media.SystemSounds]::Asterisk.Play()
        }
        "Failed" {
            [System.Media.SystemSounds]::Hand.Play()
        }
        "ActionRequired" {
            [System.Media.SystemSounds]::Exclamation.Play()
        }
    }
}
catch {}

try {
    Import-Module BurntToast -ErrorAction Stop

    New-BurntToastNotification `
        -Text $Title, $Message `
        -Silent |
        Out-Null
}
catch {
    Add-Content `
        -Path "$env:TEMP\agent-notification-error.log" `
        -Value "$(Get-Date): $($_.Exception.Message)"
}

# Codex Stop hooks require valid JSON on stdout.
if ($HookOutput) {
    [Console]::Out.WriteLine("{}")
}