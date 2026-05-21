#!/usr/bin/env bash
# publish-plugin-npm-clawhub.sh — Bake ROUTING_BASE_URL from an env file into the plugin as a
# static default, then publish to npm and ClawHub.
#
# Usage:
#   ./scripts/publish-plugin-npm-clawhub.sh                        # uses .env.dev by default
#   ./scripts/publish-plugin-npm-clawhub.sh --env-file .env.prod
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
ENV_FILE="$REPO_ROOT/.env.dev"
TRANSPORT_FILE="$REPO_ROOT/openclaw-plugin/src/transport.ts"
SCHEMA_FILE="$REPO_ROOT/openclaw-plugin/schema/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Load env file ─────────────────────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found at $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ROUTING_BASE_URL="${ROUTING_BASE_URL:?ROUTING_BASE_URL is not set in .env}"

# ── Patch transport.ts with the static URL ────────────────────────────────────

echo "Patching routingBaseUrl default → $ROUTING_BASE_URL"
sed -i '' "s|section.routingBaseUrl ?? \"[^\"]*\"|section.routingBaseUrl ?? \"${ROUTING_BASE_URL}\"|" "$TRANSPORT_FILE"
sed -i '' "s|\"default\": \"http[^\"]*\"|\"default\": \"${ROUTING_BASE_URL}\"|" "$SCHEMA_FILE"

# ── Publish ───────────────────────────────────────────────────────────────────

PLUGIN_DIR="$REPO_ROOT/openclaw-plugin"
VERSION=$(node -p "require('$PLUGIN_DIR/package.json').version")
REPO="${CLAWHUB_REPO:-dearken10/openclaw-whatsapp-plugin}"
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

echo ""
echo "Publishing openclaw-channel-whatsapp-official@$VERSION"
echo "  routingBaseUrl default : $ROUTING_BASE_URL"
echo "  source repo            : $REPO"
echo "  source commit          : $SHA"
echo ""

# npm
echo "── npm publish ──────────────────────────────────────────────────────────"
(cd "$PLUGIN_DIR" && npm publish --access public ${NPM_OTP:+--otp "$NPM_OTP"})

# ClawHub
echo ""
echo "── clawhub publish ──────────────────────────────────────────────────────"
clawhub package publish "$PLUGIN_DIR" \
  --family code-plugin \
  --source-repo "$REPO" \
  --source-commit "$SHA" \
  --source-path openclaw-plugin

echo ""
echo "✓ Published openclaw-channel-whatsapp-official@$VERSION"
echo "  Install with:"
echo "    pnpm openclaw plugins install openclaw-channel-whatsapp-official@$VERSION"
