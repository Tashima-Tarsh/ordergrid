$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot ".ordergrid-local"
$runtimeRoot = Join-Path $stateRoot "runtime"
$nodeRoot = Join-Path $runtimeRoot "node"
$envPath = Join-Path $repoRoot ".env.local"
$pidPath = Join-Path $stateRoot "server.pid"
$logPath = Join-Path $stateRoot "server.log"
$errorLogPath = Join-Path $stateRoot "server-error.log"
$localUrl = "http://127.0.0.1:3000"

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function Get-NodeMajor([string]$Path) {
  try {
    if (-not (Test-Path $Path)) { return 0 }
    return [int](& $Path -p "process.versions.node.split('.')[0]")
  } catch { return 0 }
}

function Resolve-LocalNode {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode -and (Get-NodeMajor $systemNode.Source) -ge 22) {
    return @{ node = $systemNode.Source; npm = (Join-Path (Split-Path $systemNode.Source -Parent) "npm.cmd") }
  }

  $secureBrowserNode = Join-Path $env:LOCALAPPDATA "OrderGrid\runtime\node\node.exe"
  if ((Get-NodeMajor $secureBrowserNode) -ge 22) {
    return @{ node = $secureBrowserNode; npm = (Join-Path (Split-Path $secureBrowserNode -Parent) "npm.cmd") }
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
  if ((Get-NodeMajor $nodeExe) -lt 22 -or -not (Test-Path $npmExe)) { throw "Local Node.js validation failed." }
  return @{ node = $nodeExe; npm = $npmExe }
}

function New-RandomBase64([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

function New-RandomHex([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ([BitConverter]::ToString($buffer)).Replace("-", "").ToLowerInvariant()
}

function Ensure-LocalConfig {
  if (Test-Path $envPath) { return }

  Write-Host ""
  Write-Host "First local setup" -ForegroundColor Cyan
  Write-Host "OrderGrid will run on this PC. Supabase/Postgres remains the shared database."
  Write-Host ""

  $databaseUrl = Read-Host "DATABASE_URL (Supabase/Postgres connection string)"
  if ([string]::IsNullOrWhiteSpace($databaseUrl)) { throw "DATABASE_URL is required." }

  $adminEmail = Read-Host "OrderGrid admin email"
  if ([string]::IsNullOrWhiteSpace($adminEmail)) { throw "Admin email is required." }

  $securePassword = Read-Host "OrderGrid admin password (14+ characters)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try { $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($adminPassword.Length -lt 14) { throw "Admin password must be at least 14 characters." }

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
  Write-Host ""
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
  } catch { return $false }
}

Write-Host ""
Write-Host "OrderGrid Local" -ForegroundColor Cyan
Write-Host "Local web app + local Secure Browser + shared Supabase data"
Write-Host ""

Ensure-LocalConfig
Import-LocalEnv

if (Test-OrderGridHealth) {
  Write-Host "OrderGrid is already running locally." -ForegroundColor Green
  Start-Process $localUrl
  exit 0
}

$runtime = Resolve-LocalNode
$nodeExe = [string]$runtime.node
$npmExe = [string]$runtime.npm

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

  Write-Host "Applying database migrations..." -ForegroundColor DarkGray
  & $nodeExe (Join-Path $repoRoot "dist\migrate.js")
  if ($LASTEXITCODE -ne 0) { throw "Database migration failed." }

  if (Test-Path $logPath) { Remove-Item $logPath -Force }
  $process = Start-Process -FilePath $nodeExe -ArgumentList (Join-Path $repoRoot "dist\server.js") -WorkingDirectory $repoRoot -RedirectStandardOutput $logPath -RedirectStandardError $logPath -WindowStyle Hidden -PassThru
  Set-Content -Path $pidPath -Value $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-OrderGridHealth) { break }
    if ($process.HasExited) { throw "OrderGrid server exited during startup. See .ordergrid-local\server.log" }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-OrderGridHealth)) { throw "OrderGrid did not become healthy. See .ordergrid-local\server.log" }

  Write-Host ""
  Write-Host "OrderGrid is running locally." -ForegroundColor Green
  Write-Host "Open: $localUrl"
  Write-Host "Retailer browser execution stays on this Windows PC; Render is not used."
  Write-Host "After signing in, use Retailer Accounts > Install Secure Browser once." -ForegroundColor Yellow
  Write-Host ""
  Start-Process $localUrl
} finally {
  Pop-Location
}
