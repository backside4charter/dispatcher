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
Write-Host "downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Target

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
