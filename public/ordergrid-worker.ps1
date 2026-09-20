$ErrorActionPreference = "Stop"
Write-Host ""
Write-Host "OrderGrid Secure Browser Worker" -ForegroundColor Cyan
Write-Host "One-time setup. After installation, the worker starts automatically when this Windows user signs in."
Write-Host "Protected retailer steps such as OTP, CAPTCHA and 3DS remain manual."
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 22+ is required. Opening the official download page..." -ForegroundColor Yellow
  Start-Process "https://nodejs.org/en/download"
  throw "Install Node.js 22 or newer, then run this installer again."
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { throw "Node.js 22 or newer is required." }

$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$pf86 = [Environment]::GetFolderPath("ProgramFilesX86")
if ($pf86) { $chromePaths += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe") }
if (-not ($chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1)) {
  Start-Process "https://www.google.com/chrome/"
  throw "Google Chrome is required. Install Chrome, then run this installer again."
}

$base = Join-Path $env:LOCALAPPDATA "OrderGrid"
$workerRoot = Join-Path $base "worker"
$configPath = Join-Path $base "worker-config.json"
$launcherPath = Join-Path $base "start-worker.ps1"
$logPath = Join-Path $base "worker.log"
$zip = Join-Path $env:TEMP "ordergrid-main.zip"
$extract = Join-Path $env:TEMP "ordergrid-worker-install"

New-Item -ItemType Directory -Path $base -Force | Out-Null
if (Test-Path $workerRoot) { Remove-Item $workerRoot -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }

Write-Host "Downloading the current OrderGrid worker..." -ForegroundColor DarkGray
Invoke-WebRequest -Uri "https://github.com/Tashima-Tarsh/ordergrid/archive/refs/heads/main.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $extract -Force
Move-Item (Join-Path $extract "ordergrid-main") $workerRoot

$defaultUrl = if ([string]::IsNullOrWhiteSpace($env:ORDERGRID_URL)) { "https://ordergrid-production.onrender.com" } else { $env:ORDERGRID_URL }
$url = Read-Host "OrderGrid URL [$defaultUrl]"
if ([string]::IsNullOrWhiteSpace($url)) { $url = $defaultUrl }
$url = $url.TrimEnd("/")

$email = Read-Host "OrderGrid email"
if ([string]::IsNullOrWhiteSpace($email)) { throw "OrderGrid email is required." }

$securePassword = Read-Host "OrderGrid password" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

Write-Host "Authorizing this workstation..." -ForegroundColor DarkGray
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ email = $email; password = $password } | ConvertTo-Json
Invoke-RestMethod -Uri "$url/api/login" -Method Post -ContentType "application/json" -Body $loginBody -WebSession $webSession | Out-Null
$bootstrap = Invoke-RestMethod -Uri "$url/api/worker-bootstrap" -Method Get -WebSession $webSession
if ([string]::IsNullOrWhiteSpace([string]$bootstrap.workerToken)) { throw "OrderGrid did not issue a worker machine token." }

$encryptedPassword = ConvertFrom-SecureString (ConvertTo-SecureString $password -AsPlainText -Force)
$encryptedToken = ConvertFrom-SecureString (ConvertTo-SecureString ([string]$bootstrap.workerToken) -AsPlainText -Force)
@{
  url = $url
  email = $email
  password = $encryptedPassword
  workerToken = $encryptedToken
  workerRoot = $workerRoot
} | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8

$launcher = @'
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "OrderGrid"
$configPath = Join-Path $base "worker-config.json"
$logPath = Join-Path $base "worker.log"
$mutex = New-Object System.Threading.Mutex($false, "Local\OrderGridSecureBrowserWorker")
if (-not $mutex.WaitOne(0)) { exit 0 }
function Read-Protected([string]$value) {
  $secure = ConvertTo-SecureString $value
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
try {
  $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
  $env:ORDERGRID_URL = [string]$cfg.url
  $env:ORDERGRID_EMAIL = [string]$cfg.email
  $env:ORDERGRID_PASSWORD = Read-Protected ([string]$cfg.password)
  $env:ORDERGRID_WORKER_TOKEN = Read-Protected ([string]$cfg.workerToken)
  $env:ORDERGRID_PARALLEL = "4"
  $env:ORDERGRID_PRODUCT_CHECK_PARALLEL = "4"
  $env:ORDERGRID_BASKETS = "25"
  $env:ORDERGRID_DAEMON = "1"
  & node (Join-Path ([string]$cfg.workerRoot) "agent\index.mjs") *>> $logPath
} catch {
  ("[" + (Get-Date).ToString("s") + "] " + $_.Exception.Message) | Add-Content $logPath
} finally {
  $env:ORDERGRID_PASSWORD = ""
  $env:ORDERGRID_WORKER_TOKEN = ""
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
'@
Set-Content -Path $launcherPath -Value $launcher -Encoding UTF8

$startup = [Environment]::GetFolderPath("Startup")
$startupCmd = Join-Path $startup "OrderGrid Secure Browser Worker.cmd"
$cmd = '@echo off' + [Environment]::NewLine +
       'start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
Set-Content -Path $startupCmd -Value $cmd -Encoding ASCII

Write-Host ""
Write-Host "Worker installed." -ForegroundColor Green
Write-Host "It will start now and automatically after future Windows sign-ins."
Write-Host "When Flipkart asks for OTP or another protected check, complete it in the Chrome window opened by OrderGrid." -ForegroundColor Yellow
Write-Host "Worker log: $logPath" -ForegroundColor DarkGray
Write-Host ""

Start-Process "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$launcherPath
$password = ""
$bootstrap = $null
Start-Sleep -Seconds 2
Write-Host "Setup complete. Return to OrderGrid; queued Flipkart login verification will be picked up automatically." -ForegroundColor Green
