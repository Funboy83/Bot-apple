#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Please install Node.js 20 or newer from https://nodejs.org"; read -r; exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing..."
  npm install || exit 1
  npx playwright install chromium
fi
(sleep 2; open http://localhost:3777) &
node src/server.js
