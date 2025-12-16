#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_BASE="${PROJECT_ROOT}/deploy/docker-compose.yml"
COMPOSE_AUTOSTART="${PROJECT_ROOT}/deploy/docker-compose.autostart.yml"

docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_AUTOSTART}" up -d --build

echo "[wait] api-gateway http://localhost:4000/health"
until curl -fsS --max-time 2 http://localhost:4000/health >/dev/null 2>&1; do sleep 1; done
echo "[wait] llm-bridge http://localhost:5000/health"
until curl -fsS --max-time 2 http://localhost:5000/health >/dev/null 2>&1; do sleep 1; done

cat <<'EOF'
OK.

Next:
  curl -sS http://localhost:4000/devices | python -m json.tool
  node backend/tools/intent-run.js --text "打开烧水壶"
  node backend/tools/intent-run.js --text "打开烧水壶" --execute
EOF

