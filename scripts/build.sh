#!/bin/bash
set -Eeuo pipefail

CODER_PROJECTS_PATH="${CODER_PROJECTS_PATH:-$(pwd)}"

cd "${CODER_PROJECTS_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

echo "Building frontend with Vite..."
pnpm vite build

echo "Bundling server with tsup..."
pnpm tsup server/server.ts --format cjs --platform node --target node20 --outDir dist-server --no-splitting --no-minify --external vite --external @babel/core

echo "Build completed successfully!"
