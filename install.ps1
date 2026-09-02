#!/usr/bin/env pwsh
# Dispatcher installer for Windows, modeled on the bun/deno install scripts.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.ps1 | iex"
#
# Installs the latest release; pin one with  $env:DISPATCHER_VERSION = "0.3.0"
# first. Override the install directory with $env:DISPATCHER_INSTALL.
# Everything else (config, plugin, credentials) is the interactive
# `dispatcher init`, run afterwards inside your repository.
$ErrorActionPreference = "Stop"

# The one-liner runs this under Windows PowerShell 5.1, which needs both of
# these: progress rendering throttles Invoke-WebRequest to a crawl on a large
# file (~60s for this binary vs a few seconds without), and older configs
# negotiate a TLS version GitHub's CDN rejects mid-transfer.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "backside4charter/dispatcher"
$Asset = "dispatcher-windows-x64.exe"
$InstallDir = if ($env:DISPATCHER_INSTALL) { $env:DISPATCHER_INSTALL } else { Join-Path $env:LOCALAPPDATA "Programs\dispatcher" }
$Url = if ($env:DISPATCHER_VERSION) {
  "https://github.com/$Repo/releases/download/v$($env:DISPATCHER_VERSION)/$Asset"
} else {
  "https://github.com/$Repo/releases/latest/download/$Asset"
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
$Target = Join-Path $InstallDir "dispatcher.exe"

# A large download over a flaky moment gets reset; retry it rather than
# failing the whole install on the first dropped connection.
$Attempts = 3
for ($i = 1; $i -le $Attempts; $i++) {
  try {
    Write-Host "downloading $Url$(if ($i -gt 1) { " (attempt $i of $Attempts)" })"
    Invoke-WebRequest -Uri $Url -OutFile $Target
    break
  } catch {
    Remove-Item $Target -ErrorAction SilentlyContinue
    if ($i -eq $Attempts) { throw }
    Write-Host "download failed ($($_.Exception.Message)); retrying..."
    Start-Sleep -Seconds 2
  }
}

$Version = & $Target version
Write-Host "installed $Version -> $Target"

# Add the install directory to the user PATH once; new terminals pick it up,
# and the current session gets it immediately.
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
  $env:Path = "$env:Path;$InstallDir"
  Write-Host "added $InstallDir to your user PATH"
} else {
  Write-Host "$InstallDir is already on your PATH"
}

Write-Host ""
Write-Host "next: cd into your repository and run:  dispatcher init"
