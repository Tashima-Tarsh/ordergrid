$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot ".ordergrid-local"
$runtimeRoot = Join-Path $stateRoot "runtime"
$nodeRoot = Join-Path $runtimeRoot "node"
$envPath = Join-Path $repoRoot ".env.local"

$serverPidPath = Join-Path $stateRoot "server.pid"
$serverLogPath = Join-Path $stateRoot "server.log"
$serverErrorLogPath = Join-Path $stateRoot "server-error.log"

$workerPidPath = Join-Path $stateRoot "worker.pid"
$workerLogPath = Join-Path $stateRoot "worker.log"
$workerErrorLogPath = Join-Path $stateRoot "worker-error.log"

$localUrl = "http://127.0.0.1:3000"
$profileRoot = Join-Path $env:LOCALAPPDATA "OrderGrid\profiles"

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function Get-NodeMajor([string]$Path) {
  try {
    if (-not (Test-Path $Path)) { return 0 }
    return [int](& $Path -p "process.versions.node.split('.')[0]")
  } catch {
    return 0
  }
}

function Resolve-LocalNode {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode -and (Get-NodeMajor $systemNode.Source) -ge 22) {
    return @{ node = $systemNode.Source; npm = (Join-Path (Split-Path $systemNode.Source -Parent) "npm.cmd") }
  }

  $existingOrderGridNode = Join-Path $env:LOCALAPPDATA "OrderGrid\runtime\node\node.exe"
  if ((Get-NodeMajor $existingOrderGridNode) -ge 22) {
    return @{ node = $existingOrderGridNode; npm = (Join-Path (Split-Path $existingOrderGridNode -Parent) "npm.cmd") }
  }

  $localNode = Join-Path $nodeRoot "node.exe"
  if ((Get-NodeMajor $localNode) -ge 22) {
    return @{ node = $localNode; npm = (Join-Path $nodeRoot "npm.cmd") }
  }

  Write-Host "Preparing local Node.js runtime..." -ForegroundColor DarkGray

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
  $listing = Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v22.x/"
  $pattern = 'href="(?<file>node-v22\.[^"]+-' + [regex]::Escape($arch) + '\.zip)"'
  $match = [regex]::Match([string]$listing.Content, $pattern)
  if (-not $match.Success) { throw "Could not resolve the local Node.js runtime." }

  $zipPath = Join-Path $env:TEMP "ordergrid-local-node.zip"
  $extractPath = Join-Path $env:TEMP "ordergrid-local-node"

  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
  if (Test-Path $nodeRoot) { Remove-Item $nodeRoot -Recurse -Force }

  Invoke-WebRequest -UseBasicParsing -Uri ("https://nodejs.org/dist/latest-v22.x/" + $match.Groups["file"].Value) -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $expanded = Get-ChildItem $extractPath -Directory | Select-Object -First 1
  if (-not $expanded) { throw "Local Node.js extraction failed." }

  Move-Item $expanded.FullName $nodeRoot

  $nodeExe = Join-Path $nodeRoot "node.exe"
  $npmExe = Join-Path $nodeRoot "npm.cmd"
  if ((Get-NodeMajor $nodeExe) -lt 22 -or -not (Test-Path $npmExe)) {
    throw "Local Node.js validation failed."
  }

  return @{ node = $nodeExe; npm = $npmExe }
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

function New-RandomHex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ([BitConverter]::ToString($buffer)).Replace("-", "").ToLowerInvariant()
}

function Ensure-LocalConfig {
  if (Test-Path $envPath) { return }

  Write-Host ""
  Write-Host "First local setup" -ForegroundColor Cyan
  Write-Host "OrderGrid will run on this PC. Supabase/Postgres remains the shared database."
  Write-Host ""

  $databaseUrl = Read-Host "DATABASE_URL (existing Supabase/Postgres connection string)"
  if ([string]::IsNullOrWhiteSpace($databaseUrl)) { throw "DATABASE_URL is required." }

  $adminEmail = Read-Host "Existing OrderGrid login email (or first admin email for a new database)"
  if ([string]::IsNullOrWhiteSpace($adminEmail)) { throw "OrderGrid login email is required." }

  $securePassword = Read-Host "Existing OrderGrid password (14+ characters)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if ($adminPassword.Length -lt 14) { throw "OrderGrid password must be at least 14 characters." }

  @(
    "NODE_ENV=production",
    "PORT=3000",
    "APP_ORIGIN=$localUrl",
    "DATABASE_URL=$databaseUrl",
    "DB_POOL_MAX=5",
    "DB_SSL_REJECT_UNAUTHORIZED=true",
    "WORKER_API_TOKEN=$(New-RandomHex 32)",
    "SESSION_SECRET=$(New-RandomBase64 48)",
    "DATA_ENCRYPTION_KEY_BASE64=$(New-RandomBase64 48)",
    "BOOTSTRAP_ADMIN_EMAIL=$adminEmail",
    "BOOTSTRAP_ADMIN_PASSWORD=$adminPassword",
    "CARD_PROVIDER=disabled",
    "ORDERGRID_MANAGED_EXECUTION=false"
  ) | Set-Content -Path $envPath -Encoding UTF8

  $adminPassword = ""
  Write-Host "Local configuration created at .env.local" -ForegroundColor Green
}

function Import-LocalEnv {
  Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }

    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }

    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }

  $env:ORDERGRID_MANAGED_EXECUTION = "false"
}

function Test-OrderGridHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/api/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-PidAlive([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }

  $raw = (Get-Content $Path -Raw).Trim()
  if ($raw -notmatch '^\d+$') { return $false }

  return $null -ne (Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue)
}

function Start-LocalWorker([string]$NodeExe) {
  if (Test-PidAlive $workerPidPath) {
    Write-Host "Retailer authentication worker is already running." -ForegroundColor Green
    return
  }

  $env:ORDERGRID_URL = $localUrl
  $env:ORDERGRID_EMAIL = $env:BOOTSTRAP_ADMIN_EMAIL
  $env:ORDERGRID_PASSWORD = $env:BOOTSTRAP_ADMIN_PASSWORD
  $env:ORDERGRID_PROFILE_ROOT = $profileRoot
  $env:ORDERGRID_SESSION_CLAIM = "1"
  $env:ORDERGRID_PARALLEL = "4"
  $env:ORDERGRID_PRODUCT_CHECK_PARALLEL = "2"
  $env:ORDERGRID_BASKETS = "25"
  $env:ORDERGRID_DAEMON = "1"
  $env:ORDERGRID_HEADLESS = ""

  New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null

  if (Test-Path $workerLogPath) { Remove-Item $workerLogPath -Force }
  if (Test-Path $workerErrorLogPath) { Remove-Item $workerErrorLogPath -Force }

  $worker = Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $repoRoot "agent\index.mjs") -WorkingDirectory $repoRoot -RedirectStandardOutput $workerLogPath -RedirectStandardError $workerErrorLogPath -WindowStyle Hidden -PassThru
  Set-Content -Path $workerPidPath -Value $worker.Id -Encoding ASCII

  Start-Sleep -Milliseconds 800
  if ($worker.HasExited) {
    throw "Retailer authentication worker exited during startup. See .ordergrid-local\worker-error.log"
  }

  Write-Host "Retailer authentication worker is running." -ForegroundColor Green
}

Write-Host ""
Write-Host "OrderGrid Local" -ForegroundColor Cyan
Write-Host "Local web app + local Edge/Chrome retailer sessions + shared Supabase data"
Write-Host ""

Ensure-LocalConfig
Import-LocalEnv

$runtime = Resolve-LocalNode
$nodeExe = [string]$runtime.node
$npmExe = [string]$runtime.npm

if (Test-OrderGridHealth) {
  Start-LocalWorker $nodeExe
  Write-Host "OrderGrid is already running locally." -ForegroundColor Green
  Start-Process $localUrl
  exit 0
}

Push-Location $repoRoot
try {
  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Host "Installing application dependencies..." -ForegroundColor DarkGray
    & $npmExe ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  }

  Write-Host "Building OrderGrid..." -ForegroundColor DarkGray
  & $npmExe run build:local
  if ($LASTEXITCODE -ne 0) { throw "OrderGrid build failed." }

  if ($env:ORDERGRID_LOCAL_MIGRATE -eq "true") {
    Write-Host "Applying database migrations..." -ForegroundColor DarkGray
    & $nodeExe (Join-Path $repoRoot "dist\migrate.js")
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed." }
  } else {
    Write-Host "Using the existing shared database schema." -ForegroundColor DarkGray
  }

  if (Test-Path $serverLogPath) { Remove-Item $serverLogPath -Force }
  if (Test-Path $serverErrorLogPath) { Remove-Item $serverErrorLogPath -Force }

  $server = Start-Process -FilePath $nodeExe -ArgumentList (Join-Path $repoRoot "dist\server.js") -WorkingDirectory $repoRoot -RedirectStandardOutput $serverLogPath -RedirectStandardError $serverErrorLogPath -WindowStyle Hidden -PassThru
  Set-Content -Path $serverPidPath -Value $server.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-OrderGridHealth) { break }
    if ($server.HasExited) {
      throw "OrderGrid server exited during startup. See .ordergrid-local\server-error.log"
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not (Test-OrderGridHealth)) {
    throw "OrderGrid did not become healthy. See .ordergrid-local\server-error.log"
  }

  Start-LocalWorker $nodeExe

  Write-Host ""
  Write-Host "OrderGrid is running locally." -ForegroundColor Green
  Write-Host "Open: $localUrl"
  Write-Host "Retailer authentication and checkout use Edge/Chrome on this Windows PC."
  Write-Host "Go to Retailer Accounts and choose Connect all accounts." -ForegroundColor Yellow
  Write-Host "Accounts are authenticated one at a time; enter each Flipkart OTP when requested." -ForegroundColor Yellow
  Write-Host ""

  Start-Process $localUrl
} finally {
  Pop-Location
}
