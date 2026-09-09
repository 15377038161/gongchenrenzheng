#!/bin/bash
set -Eeuo pipefail


PORT=5000
CODER_PROJECTS_PATH="${CODER_PROJECTS_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"


cd "${CODER_PROJECTS_PATH}"

kill_port_if_listening() {
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening
echo "Starting express + Vite dev server on port ${DEPLOY_RUN_PORT}..."

# start server with timestamp
PORT=${DEPLOY_RUN_PORT} pnpm tsx watch server/server.ts 2>&1 \
1> >(
  while IFS= read -r line || [[ -n "$line" ]]; do
    echo "$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M:%S") [INFO] $line" >> app.log
  done
) \
2> >(
  while IFS= read -r line || [[ -n "$line" ]]; do
    echo "$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M:%S") [ERROR] $line" >> app.log
  done
)