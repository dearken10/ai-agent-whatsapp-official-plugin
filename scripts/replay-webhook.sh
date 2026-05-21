#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:28080}"
APP_SECRET="${WEBHOOK_APP_SECRET:-dev-secret}"
FROM_PHONE="${FROM_PHONE:-+85260000000}"
TEXT="${TEXT:-hello from webhook replay}"
MESSAGE_ID="${MESSAGE_ID:-wamid.$(date +%s)}"

PAYLOAD="$(cat <<EOF
{
  "entry": [
    {
      "changes": [
        {
          "value": {
            "messages": [
              {
                "from": "${FROM_PHONE}",
                "id": "${MESSAGE_ID}",
                "text": {
                  "body": "${TEXT}"
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
EOF
)"

SIGNATURE="$(printf "%s" "${PAYLOAD}" | openssl dgst -sha256 -hmac "${APP_SECRET}" -hex | awk '{print $2}')"

curl -s -X POST "${BASE_URL}/webhooks/whatsapp" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=${SIGNATURE}" \
  -d "${PAYLOAD}"
echo
