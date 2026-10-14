#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_DIR:?APP_DIR is required}"
: "${APP_IMAGE:?APP_IMAGE is required}"
: "${COMPOSE_CANDIDATE:?COMPOSE_CANDIDATE is required}"

if [[ "$APP_DIR" != "/opt/va-dashboard" ]]; then
  echo "APP_DIR must be /opt/va-dashboard" >&2
  exit 2
fi
if [[ ! "$APP_IMAGE" =~ ^ghcr\.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:[a-f0-9]{64}$ ]]; then
  echo "APP_IMAGE must be the verified VA Dashboard GHCR digest" >&2
  exit 2
fi
if [[ "$COMPOSE_CANDIDATE" != "$APP_DIR/.docker-compose.yml.candidate" ]]; then
  echo "Unexpected Compose candidate path" >&2
  exit 2
fi
if [[ ! -s "$APP_DIR/.env" || ! -s "$COMPOSE_CANDIDATE" ]]; then
  echo "The host .env and uploaded Compose candidate must exist" >&2
  exit 2
fi
if ! command -v docker >/dev/null || ! command -v curl >/dev/null || ! command -v flock >/dev/null; then
  echo "Docker, curl, and flock are required on the host" >&2
  exit 2
fi

cd "$APP_DIR"
exec 9>"$APP_DIR/.deploy.lock"
if ! flock -n 9; then
  echo "Another deployment is already running" >&2
  exit 2
fi

chmod 600 "$APP_DIR/.env"
compose_file="$APP_DIR/docker-compose.yml"
previous_compose="$APP_DIR/.docker-compose.yml.previous"
had_compose=false
previous_image_id=""
rollback_image_tag=""
if [[ -f "$compose_file" ]]; then
  had_compose=true
  cp -p "$compose_file" "$previous_compose"
  old_container="$(docker compose --env-file "$APP_DIR/.env" -f "$compose_file" ps -q app 2>/dev/null || true)"
  if [[ -n "$old_container" ]]; then
    previous_image_id="$(docker inspect --format '{{.Image}}' "$old_container")"
    rollback_image_tag="va-dashboard-rollback:rollback-$(date -u +%Y%m%dT%H%M%S%N)-$$"
    docker image tag "$previous_image_id" "$rollback_image_tag"
  fi
fi

wait_until_healthy() {
  local image="$1" health_url
  local published_port container health_state

  if ! published_port="$(APP_IMAGE="$image" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" port app 3000)"; then
    echo "Could not resolve the application health-check port" >&2
    return 1
  fi
  if [[ ! "$published_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
    echo "App port must be published on IPv4 loopback only; got: $published_port" >&2
    return 1
  fi

  local health_url="http://127.0.0.1:${BASH_REMATCH[1]}/api/health"
  for attempt in {1..30}; do
    container="$(APP_IMAGE="$image" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" ps -q app)"
    if [[ -n "$container" ]]; then
      health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)"
      if [[ "$health_state" == "healthy" ]] && curl --silent --show-error --fail --max-time 5 "$health_url" >/dev/null; then
        return 0
      fi
    fi
    sleep 5
  done

  echo "Application did not pass its container and database health checks" >&2
  return 1
}

rollback() {
  status=$?
  trap - ERR
  set +e
  echo "Deployment failed; restoring the previous application state" >&2
  if [[ "$had_compose" == true ]]; then
    cp -p "$previous_compose" "$compose_file"
    if [[ -n "$rollback_image_tag" ]]; then
      if APP_IMAGE="$rollback_image_tag" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" up --pull never -d --no-build --force-recreate app; then
        if wait_until_healthy "$rollback_image_tag"; then
          echo "Previous application image restored and healthy: $rollback_image_tag" >&2
        else
          echo "Previous application image was restored but did not pass health checks" >&2
        fi
      else
        echo "Could not restore the previous application image" >&2
      fi
    else
      APP_IMAGE="$APP_IMAGE" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" rm --stop --force app
      echo "First deployment failed; its application container was removed. No previous version was available." >&2
    fi
  else
    APP_IMAGE="$APP_IMAGE" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" rm --stop --force app
    rm -f "$compose_file"
    echo "First deployment failed; its application container was removed. No previous version was available." >&2
  fi
  rm -f "$COMPOSE_CANDIDATE"
  exit "$status"
}
trap rollback ERR

APP_IMAGE="$APP_IMAGE" docker compose --env-file "$APP_DIR/.env" -f "$COMPOSE_CANDIDATE" config --quiet
mv "$COMPOSE_CANDIDATE" "$compose_file"
APP_IMAGE="$APP_IMAGE" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" pull app
APP_IMAGE="$APP_IMAGE" docker compose --env-file "$APP_DIR/.env" -f "$compose_file" up -d --no-build --force-recreate app

wait_until_healthy "$APP_IMAGE"

trap - ERR
rm -f "$previous_compose"
echo "Deployment healthy: $APP_IMAGE"
