#!/usr/bin/env bash
set -euo pipefail

if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # Use the repository's .nvmrc so native modules match the runtime ABI.
  set +u
  # shellcheck source=/dev/null
  . "${HOME}/.nvm/nvm.sh"
  nvm use --silent >/dev/null
  set -u
fi

# ---- Ports ------------------------------------------------------------------
# Bind to all interfaces so the apps are reachable from other devices on the WLAN.
export WORKTREEHUB_HOST="${WORKTREEHUB_HOST:-0.0.0.0}"
WORKTREEHUB_PORT="${WORKTREEHUB_PORT:-3767}"
WORKTREEHUB_WEB_PORT="${WORKTREEHUB_WEB_PORT:-4173}"

LOG_DIR="${LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"

# Best-effort detection of this machine's LAN IP for a convenient connect URL.
lan_ip="$(node -e "const os=require('node:os'); for (const entries of Object.values(os.networkInterfaces())) for (const item of entries ?? []) if (item.family === 'IPv4' && !item.internal) { console.log(item.address); process.exit(0) }" 2>/dev/null || true)"

# ---- Build all apps ---------------------------------------------------
pnpm build

echo "Running database migrations..."
node --input-type=module <<'EOF'
import { createDatabase } from './apps/server/dist/db/database.js'
import { getConfig } from './apps/server/dist/config.js'

const config = getConfig()
const db = createDatabase(config.databasePath)
db.close()

console.log(`Database migrated at ${config.databasePath}`)
EOF

# ---- Start all apps in the background ---------------------------------
echo
echo "Starting all services (logs in $LOG_DIR)..."

pnpm --filter @worktreehub/server start \
  >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

pnpm --filter @worktreehub/web preview -- --host "$WORKTREEHUB_HOST" --port "$WORKTREEHUB_WEB_PORT" \
  >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

cleanup() {
  echo
  echo "Stopping all services..."
  kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---- Summary ---------------------------------------------------------------
echo
echo "WorktreeHub server    → http://${WORKTREEHUB_HOST}:${WORKTREEHUB_PORT}"
echo "WorktreeHub web       → http://${WORKTREEHUB_HOST}:${WORKTREEHUB_WEB_PORT}"
if [ -n "${lan_ip:-}" ]; then
  echo
  echo "From other devices on the WLAN:"
  echo "  server    → http://${lan_ip}:${WORKTREEHUB_PORT}"
  echo "  web       → http://${lan_ip}:${WORKTREEHUB_WEB_PORT}"
fi
echo
echo "Logs:"
echo "  tail -f $LOG_DIR/server.log"
echo "  tail -f $LOG_DIR/web.log"
echo
echo "Press Ctrl-C to stop all services."

# Block until the script is interrupted (the EXIT trap kills the children).
wait
