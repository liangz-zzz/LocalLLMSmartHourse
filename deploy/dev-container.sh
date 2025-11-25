#!/usr/bin/env bash
set -euo pipefail

# Simple dev-shell helper to build/run a single container for the whole repo.
# It mirrors the "build/start/into" workflow shown in the user snippet.

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE_PATH="${PROJECT_ROOT}/deploy/Dockerfile.dev"

DOCKER_REPO="${DOCKER_REPO:-localllm-smarthouse}"
IMAGE_TAG="${IMAGE_TAG:-dev-shell}"
IMAGE_VERSION="${IMAGE_VERSION:-v0.1}"
IMAGE_NAME="${IMAGE_NAME:-${DOCKER_REPO}/${IMAGE_TAG}:${IMAGE_VERSION}}"
CONTAINER_NAME="${CONTAINER_NAME:-localllm-dev.${USER:-dev}}"

HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

build_image() {
  docker build \
    --build-arg LOCAL_UID="$(id -u)" \
    --build-arg LOCAL_GID="$(id -g)" \
    --build-arg NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}" \
    -f "${DOCKERFILE_PATH}" \
    -t "${IMAGE_NAME}" \
    "${PROJECT_ROOT}"
}

start_container() {
  if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  fi

  gpu_flags=()
  if [[ "${ENABLE_GPU:-0}" == "1" ]]; then
    if docker info 2>/dev/null | grep -qiE 'nvidia|gpu'; then
      gpu_flags+=(--gpus all)
      echo "GPU support detected; starting with --gpus all"
    else
      echo "ENABLE_GPU=1 set but Docker GPU support not detected; starting without --gpus"
    fi
  fi

  env_args=()
  for var in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy TZ; do
    if [[ -n "${!var-}" ]]; then
      env_args+=("-e" "${var}=${!var}")
    fi
  done

  run_args=(
    -d
    -it
    --name "${CONTAINER_NAME}"
    -v "${PROJECT_ROOT}:/workspace"
    -w /workspace
  )

  if [[ "${HOST_OS}" == "linux" ]]; then
    run_args+=(--network host)
  fi

  run_args+=("${gpu_flags[@]}")
  run_args+=("${env_args[@]}")
  run_args+=("${IMAGE_NAME}")

  docker run "${run_args[@]}"
}

enter_container() {
  docker exec -it "${CONTAINER_NAME}" /bin/bash
}

stop_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}

usage() {
  cat <<'EOF'
Usage: deploy/dev-container.sh [build|start|into|stop]
  build   Build the dev shell image (Dockerfile.dev) with host UID/GID
  start   Run the container in background and mount the repo to /workspace
  into    Enter the running container with bash
  stop    Remove the dev container if it exists

Env overrides:
  DOCKER_REPO, IMAGE_TAG, IMAGE_VERSION, IMAGE_NAME, CONTAINER_NAME
  NPM_REGISTRY (default https://registry.npmjs.org)
  ENABLE_GPU=1 to add --gpus all when available
  HTTP_PROXY/HTTPS_PROXY/NO_PROXY are forwarded if set
EOF
}

case "${1:-}" in
  build) build_image ;;
  start) start_container ;;
  into) enter_container ;;
  stop) stop_container ;;
  *) usage; exit 1 ;;
esac
