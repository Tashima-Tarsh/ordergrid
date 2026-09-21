$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $repoRoot ".ordergrid-local\server.pid"
if (-not (Test-Path $pidPath)) {
  Write-Host "OrderGrid Local is not running."
  exit 0
}
$pidValue = (Get-Content $pidPath -Raw).Trim()
if ($pidValue -match '^\d+$') {
  $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $proc.Id -Force
    Write-Host "OrderGrid Local stopped." -ForegroundColor Green
  } else {
    Write-Host "OrderGrid Local process was already stopped."
  }
}
Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
