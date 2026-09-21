#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_PATH/backups}"
REQUIRE_PRODUCTION="${REQUIRE_PRODUCTION:-1}"
case "$DEPLOY_PATH" in
  /*) ;;
  *) printf '%s\n' 'DEPLOY_PATH must be absolute' >&2; exit 1 ;;
esac
cd -- "$DEPLOY_PATH"

[ -f compose.yml ] || { printf '%s\n' 'compose.yml not found' >&2; exit 1; }
[ -f .env ] || { printf '%s\n' '.env not found' >&2; exit 1; }
if [ -n "$(find .env -prune -perm /077 -print -quit)" ]; then
  printf '%s\n' '.env must not be group/world-readable' >&2
  exit 1
fi

require_env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  value="${line#*=}"
  if [ -z "$line" ] || [ -z "$value" ] || [[ "$value" == *'<'* || "$value" == *'>'* ]]; then
    printf 'missing or placeholder %s in .env\n' "$key" >&2
    exit 1
  fi
}

if [ "$REQUIRE_PRODUCTION" = 1 ]; then
  require_env_value APP_URL
  if [ "${REQUIRE_HEARTBEAT:-0}" = 1 ]; then
    require_env_value HEARTBEAT_URL
  fi
  require_env_value BESZEL_AGENT_KEY
fi

docker compose config --quiet

backup_hub_data() {
  local container_id backup_file partial_file
  container_id="$(docker compose ps -q beszel)"
  [ -n "$container_id" ] || return 0
  mkdir -p -- "$BACKUP_DIR"
  chmod 700 -- "$BACKUP_DIR"
  backup_file="$BACKUP_DIR/beszel_data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  partial_file="${backup_file}.partial"
  docker compose stop beszel >/dev/null
  if ! tar -C "$DEPLOY_PATH" -czf "$partial_file" beszel_data; then
    docker compose start beszel >/dev/null || true
    rm -f -- "$partial_file"
    printf '%s\n' 'Hub data backup failed; deployment stopped' >&2
    exit 1
  fi
  mv -- "$partial_file" "$backup_file"
  docker compose start beszel >/dev/null
  printf 'Created Hub backup: %s\n' "$backup_file"
}

backup_hub_data
docker compose pull
docker compose up -d --remove-orphans

wait_for_healthy() {
  local service="$1" id state deadline
  deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(docker compose ps -q "$service")"
    if [ -n "$id" ]; then
      state="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
      case "$state" in
        healthy) return 0 ;;
        unhealthy)
          printf 'healthcheck failed: %s\n' "$service" >&2
          return 1
          ;;
      esac
    fi
    sleep 2
  done
  printf 'healthcheck timed out: %s\n' "$service" >&2
  return 1
}

if ! wait_for_healthy beszel || ! wait_for_healthy beszel-agent; then
  docker compose ps --all
  exit 1
fi

docker compose ps --all
failed=0
while IFS= read -r service; do
  [ -n "$service" ] || continue
  running="$(docker compose ps --status running --services | grep -Fx "$service" || true)"
  if [ "$running" != "$service" ]; then
    printf 'service not running: %s\n' "$service" >&2
    failed=1
  fi
done < <(docker compose config --services)
if [ "$failed" -eq 0 ] && [ ! -S "$DEPLOY_PATH/beszel_socket/beszel.sock" ]; then
  printf '%s\n' 'Beszel Agent socket not found' >&2
  failed=1
fi
exit "$failed"
