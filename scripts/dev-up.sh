#!/usr/bin/env bash
set -euo pipefail

docker compose up -d --build --force-recreate wa-backend
echo "Backend started at http://localhost:28080 (maps to container :8080)"
