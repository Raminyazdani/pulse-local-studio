$ErrorActionPreference='Stop'
$pulseRecord=Join-Path $PSScriptRoot 'data\server.json'
if (-not (Test-Path -LiteralPath $pulseRecord)) { Write-Host 'No Pulse launcher process was recorded.'; exit 0 }
$pulseServerId=[int]((Get-Content -LiteralPath $pulseRecord -Raw | ConvertFrom-Json).pid)
$pulseProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $pulseServerId" -ErrorAction SilentlyContinue
$pulseExpectedPython=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not $pulseProcess) { Write-Host 'Pulse is already stopped.'; exit 0 }
if ($pulseProcess.ExecutablePath -ne $pulseExpectedPython -or $pulseProcess.CommandLine -notmatch 'uvicorn.+backend\.app:app.+--port\s+8765') { throw 'The recorded process does not belong to this Pulse server. No process was stopped.' }
Stop-Process -Id $pulseServerId
Write-Host 'Pulse stopped. Your media, exports and saved project are preserved.'
