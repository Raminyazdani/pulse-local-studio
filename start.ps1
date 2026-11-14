param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pulseUrl = 'http://127.0.0.1:8765'
try {
    $pulseHealth = Invoke-RestMethod "$pulseUrl/api/health" -TimeoutSec 2
    if ($pulseHealth.engine -eq 'FFmpeg' -and $pulseHealth.ok) { if (-not $NoBrowser) { Start-Process $pulseUrl }; exit 0 }
} catch { }
foreach ($pulseTool in @('python','node','npm','ffmpeg','ffprobe')) {
    if (-not (Get-Command $pulseTool -ErrorAction SilentlyContinue)) { throw "Required tool missing: $pulseTool. Please install it and run Start Pulse.cmd again." }
}
$pulsePython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pulsePython)) { & python -m venv .venv; if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' } }
$pulseDependenciesReady=$false
try { & $pulsePython -c 'import fastapi, uvicorn, multipart, numpy, scipy' 2>$null; $pulseDependenciesReady=($LASTEXITCODE -eq 0) } catch { }
if (-not $pulseDependenciesReady) { & $pulsePython -m pip install -r requirements.txt; if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' } }
$pulseBuild = Join-Path $PSScriptRoot 'dist\index.html'
$pulseSourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -File -Recurse) + @(Get-Item -LiteralPath 'package.json','package-lock.json','index.html','vite.config.ts')
$pulseNeedsBuild = -not (Test-Path -LiteralPath $pulseBuild)
if (-not $pulseNeedsBuild) { $pulseBuildTime=(Get-Item -LiteralPath $pulseBuild).LastWriteTimeUtc; $pulseNeedsBuild = @($pulseSourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $pulseBuildTime }).Count -gt 0 }
if ($pulseNeedsBuild) {
    if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' } }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
$pulseData = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $pulseData -Force | Out-Null
$pulseServer = Start-Process -FilePath $pulsePython -ArgumentList @('-m','uvicorn','backend.app:app','--host','127.0.0.1','--port','8765') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $pulseData 'server.log') -RedirectStandardError (Join-Path $pulseData 'server-error.log')
@{pid=$pulseServer.Id;url=$pulseUrl} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pulseData 'server.json') -Encoding UTF8
for ($pulseAttempt=0; $pulseAttempt -lt 45; $pulseAttempt++) {
    Start-Sleep -Milliseconds 250
    if ($pulseServer.HasExited) { throw "Pulse could not start. Check data\server-error.log. Another app may be using port 8765." }
    try { $pulseHealth=Invoke-RestMethod "$pulseUrl/api/health" -TimeoutSec 1; if ($pulseHealth.engine -eq 'FFmpeg' -and $pulseHealth.ok) { Write-Host "Pulse is ready at $pulseUrl"; if (-not $NoBrowser) { Start-Process $pulseUrl }; exit 0 } } catch { }
}
throw 'Pulse did not become ready. Check data\server-error.log.'
