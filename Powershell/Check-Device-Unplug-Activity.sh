$previous = @{}

Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
    $previous[$_.InstanceId] = $_
}

Write-Host "Watching devices. Wait for the disconnect sound..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop.`n"

while ($true) {
    Start-Sleep -Milliseconds 300

    $current = @{}

    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
        $current[$_.InstanceId] = $_
    }

    foreach ($id in $previous.Keys) {
        if (-not $current.ContainsKey($id)) {
            $device = $previous[$id]

            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss.fff')] DISCONNECTED" -ForegroundColor Red
            Write-Host "Name:  $($device.FriendlyName)"
            Write-Host "Class: $($device.Class)"
            Write-Host "ID:    $($device.InstanceId)"
        }
    }

    foreach ($id in $current.Keys) {
        if (-not $previous.ContainsKey($id)) {
            $device = $current[$id]

            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss.fff')] CONNECTED" -ForegroundColor Green
            Write-Host "Name:  $($device.FriendlyName)"
            Write-Host "Class: $($device.Class)"
            Write-Host "ID:    $($device.InstanceId)"
        }
    }

    $previous = $current
}
