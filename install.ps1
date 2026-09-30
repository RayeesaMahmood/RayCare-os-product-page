# RayCare OS installer for Windows (PowerShell).
# Checks Node.js, installs the one dependency, creates .env and a data folder.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($m) { Write-Host "`n> $m" -ForegroundColor White }
function Ok($m) { Write-Host "  $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  $m" -ForegroundColor Red }

Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Bad 'Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this script again.'; exit 1 }
$ver = node -p "process.versions.node"
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if ($LASTEXITCODE -ne 0) { Bad "Node.js $ver is too old. RayCare needs 22.5 or newer."; exit 1 }
Ok "Node.js $ver"

Step 'Installing dependencies'
npm install --omit=dev --no-audit --no-fund
Ok 'Dependencies installed'

Step 'Creating configuration'
New-Item -ItemType Directory -Force -Path data | Out-Null
if (-not (Test-Path .env)) {
  $secret = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  (Get-Content .env.example) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret" | Set-Content .env
  Ok 'Created .env with a fresh signing secret'
} else { Ok '.env already exists, left unchanged' }

Write-Host "`n  RayCare OS is installed.`n"
Write-Host '    npm start        start your hospital'
Write-Host '    npm run demo     try a simulated hospital first'
Write-Host "`n  Then open http://localhost:8080/app/ to run the setup wizard.`n"
