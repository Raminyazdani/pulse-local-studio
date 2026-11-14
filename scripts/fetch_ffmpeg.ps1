param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$pulseDestination=[IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $pulseDestination -Force | Out-Null
$pulseArchive=Join-Path $pulseDestination 'ffmpeg-8.1.1-full_build.zip'
# Version and SHA256 from Microsoft's reviewed WinGet installer manifest:
# https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Gyan/FFmpeg/8.1.1/Gyan.FFmpeg.installer.yaml
$pulseUrl='https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build.zip'
$pulseExpected='49B28C5F16ADDD40239A66949973458769B7056FB7752C30AC0D53389D09A552'
if (-not (Test-Path -LiteralPath $pulseArchive)) { Invoke-WebRequest -Uri $pulseUrl -OutFile $pulseArchive }
if ((Get-FileHash -LiteralPath $pulseArchive -Algorithm SHA256).Hash -ne $pulseExpected) { throw 'FFmpeg archive checksum did not match the pinned official build.' }
$pulseExtract=Join-Path $pulseDestination 'extracted'
Expand-Archive -LiteralPath $pulseArchive -DestinationPath $pulseExtract -Force
$pulseSource=Join-Path $pulseExtract 'ffmpeg-8.1.1-full_build'
if (-not (Test-Path -LiteralPath (Join-Path $pulseSource 'bin\ffmpeg.exe'))) { throw 'FFmpeg download layout is invalid.' }
New-Item -ItemType Directory -Path (Join-Path $pulseDestination 'bin') -Force | Out-Null
foreach ($pulseName in @('ffmpeg.exe','ffprobe.exe')) { Copy-Item -LiteralPath (Join-Path $pulseSource "bin\$pulseName") -Destination (Join-Path $pulseDestination "bin\$pulseName") -Force }
foreach ($pulseName in @('LICENSE','README.txt')) { Copy-Item -LiteralPath (Join-Path $pulseSource $pulseName) -Destination (Join-Path $pulseDestination $pulseName) -Force }
Write-Host "Pinned FFmpeg 8.1.1 ready: $pulseDestination\bin"
