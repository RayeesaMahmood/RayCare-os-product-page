#!/usr/bin/env bash
# RayCare OS installer for Linux and macOS.
# Checks Node.js, installs the one dependency, creates .env and a data folder.
set -euo pipefail
cd "$(dirname "$0")"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed."
  echo "Install Node.js 22 LTS from https://nodejs.org (or use Docker: docker compose up -d) and run this script again."
  exit 1
fi
NODE_VER=$(node -p "process.versions.node")
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"; then
  red "Node.js $NODE_VER is too old. RayCare needs 22.5 or newer."
  exit 1
fi
green "Node.js $NODE_VER"

step "Installing dependencies"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund
green "Dependencies installed"

step "Creating configuration"
mkdir -p data
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env && rm -f .env.bak
  green "Created .env with a fresh signing secret"
else
  green ".env already exists, left unchanged"
fi

step "Running self-test"
npm test --silent >/dev/null 2>&1 && green "All tests passed" || red "Some tests failed. Run 'npm test' to see details."

cat <<'DONE'

  RayCare OS is installed.

    npm start        start your hospital
    npm run demo     try a simulated hospital first

  Then open http://localhost:8080/app/ to run the setup wizard.

DONE
