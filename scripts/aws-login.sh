#!/usr/bin/env bash
# aws-login.sh — Authenticate with AWS SSO for the openclaw-whatsapp deployment.
#
# Reads your AWS SSO configuration from environment variables (typically
# sourced from .env). Run this before deploy-aws.sh whenever your SSO
# session has expired.
#
# Required env (set in .env):
#   AWS_PROD_PROFILE     e.g. 123456789012_AdministratorAccess
#   AWS_DEV_PROFILE      e.g. 098765432109_AdministratorAccess
#   AWS_SSO_START_URL    e.g. https://d-xxxxxxxxxx.awsapps.com/start
#   AWS_SSO_REGION       e.g. ap-southeast-1
#
# Usage:
#   ./scripts/aws-login.sh           # login to prod ($AWS_PROD_PROFILE)
#   ./scripts/aws-login.sh --dev     # login to dev  ($AWS_DEV_PROFILE)
#   ./scripts/aws-login.sh --profile <profile-name>
#
# After login, the script exports AWS_PROFILE and prints the command to
# carry it into your current shell:
#   eval "$(./scripts/aws-login.sh)"
set -euo pipefail

# ── Load .env if present ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

PROD_PROFILE="${AWS_PROD_PROFILE:-}"
DEV_PROFILE="${AWS_DEV_PROFILE:-}"
SSO_START_URL="${AWS_SSO_START_URL:-}"
SSO_REGION="${AWS_SSO_REGION:-}"

PROFILE="$PROD_PROFILE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)     PROFILE="$DEV_PROFILE"; shift ;;
    --profile) PROFILE="$2";           shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  echo "[aws-login] ERROR: No profile selected. Set AWS_PROD_PROFILE (or AWS_DEV_PROFILE) in .env, or pass --profile <name>." >&2
  exit 1
fi
if [[ -z "$SSO_START_URL" || -z "$SSO_REGION" ]]; then
  echo "[aws-login] ERROR: AWS_SSO_START_URL and AWS_SSO_REGION must be set in .env." >&2
  exit 1
fi

# ── Ensure the profile exists in ~/.aws/config ────────────────────────────────

AWS_CONFIG="$HOME/.aws/config"
if ! grep -q "\[profile $PROFILE\]" "$AWS_CONFIG" 2>/dev/null; then
  echo "[aws-login] Profile '$PROFILE' not found in $AWS_CONFIG — adding it..." >&2
  ACCOUNT_ID="${PROFILE%%_*}"
  ROLE_NAME="${PROFILE#*_}"
  mkdir -p "$HOME/.aws"
  cat >> "$AWS_CONFIG" << EOF

[profile $PROFILE]
sso_start_url = $SSO_START_URL
sso_region = $SSO_REGION
sso_account_id = $ACCOUNT_ID
sso_role_name = $ROLE_NAME
EOF
  echo "[aws-login] Profile added." >&2
fi

# ── Check if current session is still valid ───────────────────────────────────

if AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output text > /dev/null 2>&1; then
  echo "[aws-login] Session still valid for profile '$PROFILE'" >&2
else
  echo "[aws-login] Logging in via SSO (profile: $PROFILE)..." >&2
  aws sso login --profile "$PROFILE"
fi

# ── Verify and print identity ─────────────────────────────────────────────────

echo "[aws-login] Authenticated as:" >&2
AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output table >&2

# ── Emit export so caller can eval ───────────────────────────────────────────
# When run as:  eval "$(./scripts/aws-login.sh)"
# this sets AWS_PROFILE in the calling shell so deploy-aws.sh picks it up.

echo "export AWS_PROFILE=$PROFILE"
