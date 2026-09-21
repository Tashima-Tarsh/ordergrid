$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "OrderGrid Secure Browser" -ForegroundColor Cyan
Write-Host "One-time Windows setup. No command entry is required."
Write-Host "After setup, OrderGrid starts the secure browser automatically when needed."
Write-Host ""

$base = Join-Path $env:LOCALAPPDATA "OrderGrid"
$workerRoot = Join-Path $base "worker"
$runtimeRoot = Join-Path $base "runtime"
$nodeRoot = Join-Path $runtimeRoot "node"
$configPath = Join-Path $base "worker-config.json"
$launcherPath = Join-Path $base "start-worker.ps1"
$logPath = Join-Path $base "worker.log"
$zip = Join-Path $env:TEMP "ordergrid-main.zip"
$extract = Join-Path $env:TEMP "ordergrid-worker-install"
$nodeZip = Join-Path $env:TEMP "ordergrid-node.zip"
$nodeExtract = Join-Path $env:TEMP "ordergrid-node-install"

New-Item -ItemType Directory -Path $base -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function Get-NodeMajor([string]$Path) {
  try {
    if (-not (Test-Path $Path)) { return 0 }
    return [int](& $Path -p "process.versions.node.split('.')[0]")
  } catch {
    return 0
  }
}

function Resolve-OrderGridNode {
  $localNode = Join-Path $nodeRoot "node.exe"
  if ((Get-NodeMajor $localNode) -ge 22) { return $localNode }

  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode -and (Get-NodeMajor $systemNode.Source) -ge 22) { return $systemNode.Source }

  Write-Host "Preparing the OrderGrid runtime..." -ForegroundColor DarkGray

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
  $listing = Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v22.x/"
  $pattern = 'href="(?<file>node-v22\.[^"]+-' + [regex]::Escape($arch) + '\.zip)"'
  $match = [regex]::Match([string]$listing.Content, $pattern)
  if (-not $match.Success) { throw "OrderGrid could not download its Windows runtime." }

  $fileName = $match.Groups["file"].Value
  $nodeUrl = "https://nodejs.org/dist/latest-v22.x/$fileName"

  if (Test-Path $nodeZip) { Remove-Item $nodeZip -Force }
  if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
  if (Test-Path $nodeRoot) { Remove-Item $nodeRoot -Recurse -Force }

  Invoke-WebRequest -UseBasicParsing -Uri $nodeUrl -OutFile $nodeZip
  Expand-Archive -Path $nodeZip -DestinationPath $nodeExtract -Force

  $expanded = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
  if (-not $expanded) { throw "OrderGrid runtime extraction failed." }
  Move-Item $expanded.FullName $nodeRoot

  $resolved = Join-Path $nodeRoot "node.exe"
  if ((Get-NodeMajor $resolved) -lt 22) { throw "OrderGrid runtime validation failed." }
  return $resolved
}

$browserPaths = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$pf86 = [Environment]::GetFolderPath("ProgramFilesX86")
if ($pf86) {
  $browserPaths += (Join-Path $pf86 "Microsoft\Edge\Application\msedge.exe")
  $browserPaths += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe")
}
$supportedBrowser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $supportedBrowser) {
  throw "Microsoft Edge or Google Chrome is required for the OrderGrid Secure Browser."
}

$nodeExe = Resolve-OrderGridNode

Write-Host "Installing the secure browser component..." -ForegroundColor DarkGray
if (Test-Path $workerRoot) { Remove-Item $workerRoot -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }

Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/Tashima-Tarsh/ordergrid/archive/refs/heads/main.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $extract -Force
Move-Item (Join-Path $extract "ordergrid-main") $workerRoot

$defaultUrl = if ([string]::IsNullOrWhiteSpace($env:ORDERGRID_URL)) { "https://ordergrid-production.onrender.com" } else { $env:ORDERGRID_URL }
$url = $defaultUrl.TrimEnd("/")

$workerToken = ""
$workerSessionToken = ""
$email = ""
$password = ""

if (-not [string]::IsNullOrWhiteSpace($env:ORDERGRID_SETUP_TOKEN)) {
  Write-Host "Authorizing this Windows user..." -ForegroundColor DarkGray
  $bootstrapBody = @{ setupToken = [string]$env:ORDERGRID_SETUP_TOKEN } | ConvertTo-Json
  $bootstrap = Invoke-RestMethod -Uri "$url/api/secure-browser/bootstrap" -Method Post -ContentType "application/json" -Body $bootstrapBody
  $workerToken = [string]$bootstrap.workerToken
  $workerSessionToken = [string]$bootstrap.workerSessionToken
  $email = [string]$bootstrap.userEmail
  if ([string]::IsNullOrWhiteSpace($workerToken) -or [string]::IsNullOrWhiteSpace($workerSessionToken)) {
    throw "OrderGrid could not authorize the Secure Browser. Return to OrderGrid and choose Install Secure Browser again."
  }
} else {
  Write-Host "Manual setup mode" -ForegroundColor Yellow
  $enteredUrl = Read-Host "OrderGrid URL [$defaultUrl]"
  if (-not [string]::IsNullOrWhiteSpace($enteredUrl)) { $url = $enteredUrl.TrimEnd("/") }

  $email = Read-Host "OrderGrid email"
  if ([string]::IsNullOrWhiteSpace($email)) { throw "OrderGrid email is required." }

  $securePassword = Read-Host "OrderGrid password" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

  $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $loginBody = @{ email = $email; password = $password } | ConvertTo-Json
  Invoke-RestMethod -Uri "$url/api/login" -Method Post -ContentType "application/json" -Body $loginBody -WebSession $webSession | Out-Null
  $bootstrap = Invoke-RestMethod -Uri "$url/api/worker-bootstrap" -Method Get -WebSession $webSession
  $workerToken = [string]$bootstrap.workerToken
  if ([string]::IsNullOrWhiteSpace($workerToken)) { throw "OrderGrid did not authorize the Secure Browser." }
}

$encryptedToken = ConvertFrom-SecureString (ConvertTo-SecureString $workerToken -AsPlainText -Force)
$encryptedSession = if ([string]::IsNullOrWhiteSpace($workerSessionToken)) {
  ""
} else {
  ConvertFrom-SecureString (ConvertTo-SecureString $workerSessionToken -AsPlainText -Force)
}
$encryptedPassword = if ([string]::IsNullOrWhiteSpace($password)) {
  ""
} else {
  ConvertFrom-SecureString (ConvertTo-SecureString $password -AsPlainText -Force)
}

@{
  url = $url
  email = $email
  password = $encryptedPassword
  workerToken = $encryptedToken
  workerSessionToken = $encryptedSession
  workerRoot = $workerRoot
  nodeExe = $nodeExe
} | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8

$launcher = @'
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "OrderGrid"
$configPath = Join-Path $base "worker-config.json"
$logPath = Join-Path $base "worker.log"
$mutex = New-Object System.Threading.Mutex($false, "Local\OrderGridSecureBrowserWorker")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Read-Protected([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $secure = ConvertTo-SecureString $value
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

try {
  $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
  $env:ORDERGRID_URL = [string]$cfg.url
  $env:ORDERGRID_WORKER_TOKEN = Read-Protected ([string]$cfg.workerToken)
  $env:ORDERGRID_SESSION_TOKEN = Read-Protected ([string]$cfg.workerSessionToken)

  if ([string]::IsNullOrWhiteSpace($env:ORDERGRID_SESSION_TOKEN)) {
    $env:ORDERGRID_EMAIL = [string]$cfg.email
    $env:ORDERGRID_PASSWORD = Read-Protected ([string]$cfg.password)
  }

  $env:ORDERGRID_PARALLEL = "4"
  $env:ORDERGRID_PRODUCT_CHECK_PARALLEL = "4"
  $env:ORDERGRID_BASKETS = "25"
  $env:ORDERGRID_SESSION_CLAIM = "1"
  $env:ORDERGRID_DAEMON = "1"

  $nodeExe = [string]$cfg.nodeExe
  if ([string]::IsNullOrWhiteSpace($nodeExe) -or -not (Test-Path $nodeExe)) {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
  }

  & $nodeExe (Join-Path ([string]$cfg.workerRoot) "agent\index.mjs") *>> $logPath
} catch {
  ("[" + (Get-Date).ToString("s") + "] " + $_.Exception.Message) | Add-Content $logPath
} finally {
  $env:ORDERGRID_PASSWORD = ""
  $env:ORDERGRID_SESSION_TOKEN = ""
  $env:ORDERGRID_WORKER_TOKEN = ""
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
'@

Set-Content -Path $launcherPath -Value $launcher -Encoding UTF8

$startup = [Environment]::GetFolderPath("Startup")
$startupCmd = Join-Path $startup "OrderGrid Secure Browser.cmd"
$cmd = '@echo off' + [Environment]::NewLine +
       'start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
Set-Content -Path $startupCmd -Value $cmd -Encoding ASCII

Write-Host ""
Write-Host "OrderGrid Secure Browser is ready." -ForegroundColor Green
Write-Host "It starts automatically after Windows sign-in."
Write-Host "When a retailer asks for OTP, CAPTCHA or another protected check, complete it only in the retailer browser window." -ForegroundColor Yellow
Write-Host ""

Start-Process "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File",$launcherPath

$password = ""
$workerToken = ""
$workerSessionToken = ""
$env:ORDERGRID_SETUP_TOKEN = ""
Start-Sleep -Seconds 2
Write-Host "Setup complete. Return to OrderGrid; queued retailer logins will open automatically." -ForegroundColor Green
