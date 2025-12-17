#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_BASE="${PROJECT_ROOT}/deploy/docker-compose.yml"
COMPOSE_AUTOSTART="${PROJECT_ROOT}/deploy/docker-compose.autostart.yml"
ENV_FILE="${PROJECT_ROOT}/.env"

ENV_ARGS=()
if [ -f "${ENV_FILE}" ]; then
  ENV_ARGS+=(--env-file "${ENV_FILE}")
fi

docker compose "${ENV_ARGS[@]}" -f "${COMPOSE_BASE}" -f "${COMPOSE_AUTOSTART}" up -d --build

echo "[wait] api-gateway http://localhost:4000/health"
until curl -fsS --max-time 2 http://localhost:4000/health >/dev/null 2>&1; do sleep 1; done
echo "[wait] llm-bridge http://localhost:5000/health"
until curl -fsS --max-time 2 http://localhost:5000/health >/dev/null 2>&1; do sleep 1; done
echo "[wait] smart-house-mcp-server http://localhost:7000/health"
until curl -fsS --max-time 2 http://localhost:7000/health >/dev/null 2>&1; do sleep 1; done
echo "[wait] smart-house-agent http://localhost:6000/health"
until curl -fsS --max-time 2 http://localhost:6000/health >/dev/null 2>&1; do sleep 1; done

cat <<'EOF'
OK.

Next:
  curl -sS http://localhost:4000/devices | python -m json.tool
  node backend/tools/intent-run.js --text "打开烧水壶"
  node backend/tools/intent-run.js --text "打开烧水壶" --execute
  curl -fsS http://localhost:7000/health
  curl -sS -X POST http://localhost:6000/v1/agent/turn \
    -H 'Content-Type: application/json' \
    -d '{"input":"水在烧了么","sessionId":"demo"}' | python -m json.tool
EOF
