#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:28080}"

echo "Health:"
curl -s "${BASE_URL}/healthz"
echo

echo "Pair request:"
curl -s -X POST "${BASE_URL}/api/v1/pair/request" \
  -H "Content-Type: application/json" \
  -d '{}'
echo
