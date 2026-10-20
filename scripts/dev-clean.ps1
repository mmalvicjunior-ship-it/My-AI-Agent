$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$port = 3001
Set-Location $projectRoot

function Stop-WithError([string]$Message) {
  Write-Host $Message -ForegroundColor Red
  exit 1
}

function Get-ProcessChain([int]$ProcessId) {
  $chain = @()
  $currentId = $ProcessId
  for ($depth = 0; $depth -lt 20 -and $currentId -gt 0; $depth++) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId"
    if (-not $process) { break }
    $chain += $process
    $currentId = [int]$process.ParentProcessId
  }
  return ,$chain
}

Write-Host "`n=== MyAI Agent repair ===" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError 'Node.js is not available on PATH.'
}
node --version
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Node.js is not working.' }

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Stop-WithError 'npm is not available on PATH.'
}
npm --version
if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm is not working.' }

Write-Host "`n=== Checking port $port ===" -ForegroundColor Cyan
$listenerIds = @(
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
)
$verifiedListeners = @()
$watcherIds = @()
$projectPathForMatch = $projectRoot.Replace('/', '\')

foreach ($processId in $listenerIds) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if (-not $process) {
    Stop-WithError "Could not identify PID $processId. No process was stopped."
  }

  $chain = Get-ProcessChain -ProcessId $processId
  $isNode = $process.Name -match '^node(\.exe)?$'
  $isServerCommand = [string]$process.CommandLine -match 'src[\\/]index\.js'
  $belongsToProject = $false
  foreach ($parent in $chain) {
    $commandLine = ([string]$parent.CommandLine).Replace('/', '\')
    if ($commandLine.IndexOf($projectPathForMatch, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $belongsToProject = $true
      break
    }
  }

  if (-not ($isNode -and $isServerCommand -and $belongsToProject)) {
    Write-Host "Port $port is held by a process that cannot be verified as this project's backend." -ForegroundColor Red
    Write-Host "PID: $($process.ProcessId)"
    Write-Host "Name: $($process.Name)"
    Write-Host "Command: $($process.CommandLine)"
    Stop-WithError 'No process was stopped. Inspect the listener manually.'
  }

  $verifiedListeners += $process
  foreach ($parent in $chain) {
    $parentCommand = ([string]$parent.CommandLine).Replace('/', '\')
    if ($parentCommand -match 'node\s+--watch\s+src[\\/]index\.js') {
      $watcherIds += [int]$parent.ProcessId
    }
  }
}

if ($verifiedListeners.Count -gt 0) {
  foreach ($process in $verifiedListeners) {
    Write-Host "`nVerified MyAI Agent backend listener" -ForegroundColor Yellow
    Write-Host "PID: $($process.ProcessId)"
    Write-Host "Name: $($process.Name)"
    Write-Host "Command: $($process.CommandLine)"
  }
  $answer = Read-Host 'Stop the verified project backend process(es)? Type YES to confirm'
  if ($answer -cne 'YES') {
    Write-Host 'Cancelled. No process was stopped.' -ForegroundColor Yellow
    exit 0
  }

  foreach ($watcherId in @($watcherIds | Select-Object -Unique)) {
    Write-Host "Stopping this project's stale Node watcher PID $watcherId."
    if (Get-Process -Id $watcherId -ErrorAction SilentlyContinue) {
      Stop-Process -Id $watcherId -ErrorAction Stop
    }
  }
  foreach ($process in $verifiedListeners) {
    if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
      Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
  }

  $deadline = (Get-Date).AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($remaining.Count -gt 0) {
    $remainingIds = ($remaining | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Stop-WithError "Port $port remains occupied by PID(s): $remainingIds. Not starting services."
  }
  Write-Host 'Verified project backend process(es) stopped.' -ForegroundColor Green
} else {
  Write-Host "No process is listening on port $port." -ForegroundColor Green
}

Write-Host "`n=== Checking project scripts and dependencies ===" -ForegroundColor Cyan
npm pkg get scripts
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Could not read root package.json scripts.' }
if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  Stop-WithError 'Root node_modules is missing. No packages were installed.'
}

Write-Host "`n=== Running project tests ===" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Tests failed. Services were not started.' }

Write-Host "`n=== Running smoke test ===" -ForegroundColor Cyan
npm run smoke
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Smoke test failed. Services were not started.' }

Write-Host "`n=== Starting MyAI Agent backend and frontend ===" -ForegroundColor Cyan
Write-Host 'Keep this terminal open. Press Ctrl+C to stop both services.'
npm run dev
exit $LASTEXITCODE
