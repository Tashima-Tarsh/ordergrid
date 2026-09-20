$ErrorActionPreference = "Stop"
Write-Host ""
Write-Host "OrderGrid Windows Checkout Worker" -ForegroundColor Cyan
Write-Host "This worker opens Chrome locally and uses your authorized retailer sessions."
Write-Host "It does not bypass Amazon login, OTP, CAPTCHA, 3DS, passwords, or payment authentication."
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 22+ is required. Opening the official Node.js download page..." -ForegroundColor Yellow
  Start-Process "https://nodejs.org/en/download"
  throw "Install Node.js 22 or newer, then run this file again."
}

$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) {
  Start-Process "https://nodejs.org/en/download"
  throw "Node.js 22 or newer is required."
}

$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$pf86 = [Environment]::GetFolderPath("ProgramFilesX86")
if ($pf86) { $chromePaths += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe") }
if (-not ($chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1)) {
  Start-Process "https://www.google.com/chrome/"
  throw "Google Chrome is required. Install Chrome, then run this file again."
}

$work = Join-Path $env:TEMP "ordergrid-worker"
$zip = Join-Path $env:TEMP "ordergrid-main.zip"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $work | Out-Null

Write-Host "Downloading the latest OrderGrid worker..." -ForegroundColor DarkGray
Invoke-WebRequest -Uri "https://github.com/Tashima-Tarsh/ordergrid/archive/refs/heads/main.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $work -Force
$root = Join-Path $work "ordergrid-main"

$email = Read-Host "OrderGrid email [demo@ordergrid.in]"
if ([string]::IsNullOrWhiteSpace($email)) { $email = "demo@ordergrid.in" }
$secure = Read-Host "OrderGrid password" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

$env:ORDERGRID_URL = $url
$env:ORDERGRID_EMAIL = $email
$env:ORDERGRID_PASSWORD = $password
$env:ORDERGRID_PARALLEL = "1"
$env:ORDERGRID_BASKETS = "5"
$env:ORDERGRID_DAEMON = "1"

Write-Host ""
Write-Host "Connecting worker to OrderGrid..." -ForegroundColor Green
Write-Host "When a retailer asks for sign-in, payment setup, OTP, CAPTCHA or 3DS, complete that protected step yourself. Saved/tokenized payment methods can then be reused by the isolated retailer profile." -ForegroundColor Yellow
Write-Host "Keep this window open while testing."
Write-Host ""

try {
  node (Join-Path $root "agent\index.mjs")
} finally {
  $env:ORDERGRID_PASSWORD = ""
  $password = ""
}