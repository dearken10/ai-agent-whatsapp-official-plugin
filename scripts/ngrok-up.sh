#!/usr/bin/env bash
# ngrok-up.sh — Start an ngrok tunnel to the local backend and register the
# public URL as the 360dialog inbound webhook.
#
# Usage:
#   ./scripts/ngrok-up.sh
#
# Reads credentials from .env (same directory as project root).
# Override any value with env vars before running, e.g.:
#   BACKEND_PORT=28080 ./scripts/ngrok-up.sh
set -euo pipefail

# ── Config (override via env vars or .env) ───────────────────────────────────

# Load .env from repo root if present
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BACKEND_PORT="${BACKEND_PORT:-28080}"
WEBHOOK_PATH="${WEBHOOK_PATH:-/webhooks/whatsapp}"

# 360dialog API key — used for both sending messages and registering webhook URLs
D360_API_KEY="${D360_API_KEY:?D360_API_KEY is not set. Add it to .env or export it.}"

D360_WEBHOOK_CONFIG_URL="${D360_WEBHOOK_CONFIG_URL:-https://waba-v2.360dialog.io/v1/configs/webhook}"

# ── Preflight ─────────────────────────────────────────────────────────────────

if ! command -v ngrok &>/dev/null; then
  echo "ERROR: ngrok not found."
  echo "Install from https://ngrok.com/download or: brew install ngrok"
  exit 1
fi

if ! command -v curl &>/dev/null; then
  echo "ERROR: curl not found."
  exit 1
fi

# ── Start ngrok ───────────────────────────────────────────────────────────────

# Kill any existing ngrok so we get a fresh tunnel URL
pkill -x ngrok 2>/dev/null && echo "Stopped existing ngrok process." || true
sleep 1

echo "Starting ngrok tunnel → localhost:$BACKEND_PORT ..."
nohup ngrok http "$BACKEND_PORT" --log=stdout >/tmp/ngrok-wa.log 2>&1 &
NGROK_PID=$!
disown "$NGROK_PID"

# ── Wait for tunnel to be ready ───────────────────────────────────────────────

echo "Waiting for ngrok API..."
NGROK_URL=""
for i in $(seq 1 30); do
  sleep 1
  NGROK_URL=$(
    curl -s http://localhost:4040/api/tunnels 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
https = [t['public_url'] for t in data.get('tunnels', []) if t['public_url'].startswith('https')]
print(https[0] if https else '')
" 2>/dev/null
  ) || true
  if [ -n "$NGROK_URL" ]; then
    break
  fi
done

if [ -z "$NGROK_URL" ]; then
  echo "ERROR: Could not obtain ngrok public URL after 30 seconds."
  echo "Check /tmp/ngrok-wa.log for details."
  kill "$NGROK_PID" 2>/dev/null || true
  exit 1
fi

CALLBACK_URL="${NGROK_URL}${WEBHOOK_PATH}"
echo ""
echo "  ngrok public URL : $NGROK_URL"
echo "  Callback URL     : $CALLBACK_URL"

# ── Register webhook with 360dialog ──────────────────────────────────────────

echo ""
echo "Registering webhook with 360dialog..."
RESPONSE=$(curl --silent --show-error --location "$D360_WEBHOOK_CONFIG_URL" \
  --header "D360-API-KEY: $D360_API_KEY" \
  --header "Content-Type: application/json" \
  --data "{
    \"headers\": {
      \"Ocp-Apim-Subscription-Key\": \"$D360_API_KEY\"
    },
    \"url\": \"$CALLBACK_URL\"
  }")

echo "360dialog response: $RESPONSE"

# ── Update ROUTING_BASE_URL in .env ──────────────────────────────────────────

if grep -q '^ROUTING_BASE_URL=' "$ENV_FILE"; then
  sed -i '' "s|^ROUTING_BASE_URL=.*|ROUTING_BASE_URL=${NGROK_URL}|" "$ENV_FILE"
else
  echo "ROUTING_BASE_URL=${NGROK_URL}" >> "$ENV_FILE"
fi
echo ""
echo "Updated ROUTING_BASE_URL=${NGROK_URL} in .env"

echo ""
echo "✓ Done. ngrok is running in the background (PID $NGROK_PID)."
echo "  Inspector : http://localhost:4040"
echo "  Logs      : tail -f /tmp/ngrok-wa.log"
echo "  Stop      : pkill -x ngrok"
