#!/bin/bash
set -Eeuo pipefail

CODER_PROJECTS_PATH="${CODER_PROJECTS_PATH:-$(pwd)}"

cd "${CODER_PROJECTS_PATH}"

echo "🔍 Running validate..."
pnpm validate
echo "✅ Validate passed!"
