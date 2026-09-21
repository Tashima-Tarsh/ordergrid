$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot ".ordergrid-local"

function Stop-PidFile([string]$Path,[string]$Label) {
  if (-not (Test-Path $Path)) { return }
  $raw = (Get-Content $Path -Raw).Trim()
  if ($raw -match '^\d+$') {
    $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $proc.Id -Force
      Write-Host "$Label stopped." -ForegroundColor Green
    }
  }
  Remove-Item $Path -Force -ErrorAction SilentlyContinue
}

Stop-PidFile (Join-Path $stateRoot "worker.pid") "Retailer authentication worker"
Stop-PidFile (Join-Path $stateRoot "server.pid") "OrderGrid Local server"

if (-not (Test-Path (Join-Path $stateRoot "worker.pid")) -and -not (Test-Path (Join-Path $stateRoot "server.pid"))) {
  Write-Host "OrderGrid Local is stopped."
}
