#!/usr/bin/env bash
# publish-plugin-local.sh — Patch ROUTING_BASE_URL (and schema default) from an
# env file into the plugin source without publishing.
#
# Usage:
#   ./scripts/publish-plugin-local.sh                    # uses .env  (local dev default)
#   ./scripts/publish-plugin-local.sh --env-file .env.dev
#   make publish-plugin-local                            # same as above via Makefile
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
ENV_FILE="$REPO_ROOT/.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ROUTING_BASE_URL="${ROUTING_BASE_URL:?ROUTING_BASE_URL is not set in $ENV_FILE}"

TRANSPORT_FILE="$REPO_ROOT/openclaw-plugin/src/transport.ts"
SCHEMA_FILE="$REPO_ROOT/openclaw-plugin/schema/config.json"

echo "Baking routingBaseUrl → $ROUTING_BASE_URL"
sed -i '' "s|section.routingBaseUrl ?? \"[^\"]*\"|section.routingBaseUrl ?? \"${ROUTING_BASE_URL}\"|" "$TRANSPORT_FILE"
sed -i '' "s|\"default\": \"http[^\"]*\"|\"default\": \"${ROUTING_BASE_URL}\"|" "$SCHEMA_FILE"
echo "Done. Restart the gateway to pick up the change:"
echo "  openclaw gateway restart"
