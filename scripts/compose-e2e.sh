#!/usr/bin/env bash
# End-to-end test of the Docker Compose stack. See docs/development.md.
# Needs Docker Compose >= 2.23, network access, curl and jq.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Always our own project: the teardown runs `down -v`, so an inherited
# COMPOSE_PROJECT_NAME such as `pulse` would delete real volumes.
export COMPOSE_PROJECT_NAME=pulse-e2e
project="$COMPOSE_PROJECT_NAME"

# Timeouts in seconds. Override them with environment variables.
T_UP="${E2E_TIMEOUT_UP:-600}"
T_FIRST_RESULT="${E2E_TIMEOUT_FIRST_RESULT:-90}"
T_PAGE="${E2E_TIMEOUT_PAGE:-60}"
T_INCIDENT_OPEN="${E2E_TIMEOUT_INCIDENT_OPEN:-120}"
T_INCIDENT_RESOLVE="${E2E_TIMEOUT_INCIDENT_RESOLVE:-120}"
T_NOTIFY="${E2E_TIMEOUT_NOTIFY:-60}"
T_RELOAD="${E2E_TIMEOUT_RELOAD:-60}"
T_DEMO="${E2E_TIMEOUT_DEMO:-300}"
STABLE_WINDOW="${E2E_STABLE_WINDOW:-12}"
POLL_INTERVAL="${E2E_POLL_INTERVAL:-2}"

checks_file=compose/checks.json
checks_backup=""
created_env=0

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# wait_for <timeout> <description> <command...>: run the command until it succeeds.
wait_for() {
  local timeout=$1 description=$2
  shift 2
  local deadline=$((SECONDS + timeout))
  while ! "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      fail "timeout after ${timeout}s: ${description}"
    fi
    sleep "$POLL_INTERVAL"
  done
  printf 'ok: %s\n' "$description"
}

cleanup() {
  local code=$?
  set +e
  if ((code != 0)); then
    printf '\n==> Failure (exit %s): stack state and logs\n' "$code"
    docker compose --profile demo ps --all
    docker compose --profile demo logs --no-color
  fi
  if [[ -n "$checks_backup" && -f "$checks_backup" ]]; then
    cp "$checks_backup" "$checks_file"
    rm -f "$checks_backup"
  fi
  printf '\n==> Teardown\n'
  if ! docker compose --profile demo down -v --remove-orphans && ((code == 0)); then
    code=1
  fi
  if ((created_env == 1)); then
    rm -f .env
  fi
  exit "$code"
}
trap cleanup EXIT

env_value() { # env_value <name> <default>
  local value=""
  if [[ -f .env ]]; then
    value=$(sed -n "s/^$1=//p" .env | tail -n 1)
  fi
  printf '%s' "${value:-$2}"
}

service_state() { # service_state <service>
  docker compose ps --all --format json |
    jq -rs --arg s "$1" '[.[] | select(.Service == $s) | .State] | first // "missing"'
}

is_running() { [[ "$(service_state "$1")" == "running" ]]; }

stack_snapshot() {
  local id
  docker compose ps --all --format json | jq -rs '.[] | "\(.Service) \(.State) \(.ID)"' | sort
  for id in $(docker compose ps --all -q | sort); do
    docker inspect -f '{{.Name}} restarts={{.RestartCount}}' "$id"
  done
}

api() { curl -fsS --max-time 5 "http://127.0.0.1:${api_port}$1"; }

check_state_known() {
  api /checks | jq -e '.[] | select(.id == "status-page" and .state != "unknown")'
}

has_open_incident() {
  api /incidents | jq -e '[.[] | select(.checkId == "status-page" and .resolvedAt == null)] | length > 0'
}

open_incident_id() {
  api /incidents | jq -re '[.[] | select(.checkId == "status-page" and .resolvedAt == null)] | first.id'
}

is_incident_resolved() {
  api /incidents | jq -e --arg id "$1" '.[] | select((.id | tostring) == $id and .resolvedAt != null)'
}

has_incident() {
  api /incidents | jq -e --arg id "$1" '.[] | select((.id | tostring) == $id)'
}

notify_has() {
  docker compose exec -T notify cat /data/incidents.jsonl | grep -qF -- "$1"
}

# The page is rendered in the browser from /api/checks, which the status
# service proxies from the API. So the check name is not in the HTML of GET /.
page_has_title() {
  curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/" | grep -qF 'id="checks"' &&
    curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/api/checks" | grep -qF 'Status page'
}

has_check() {
  api /checks | jq -e --arg id "$1" '.[] | select((.id | tostring) == $id)'
}

is_http_200() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1")" == "200" ]]
}

has_volume() { docker volume inspect "${project}_$1" >/dev/null 2>&1; }

assert_volume() {
  has_volume "$1" || fail "volume ${project}_$1 is missing"
}

assert_no_volume() {
  if has_volume "$1"; then fail "volume ${project}_$1 still exists"; fi
}

step "Setup (project ${project})"
for tool in docker curl jq; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done
if ! docker compose config | grep -qx "name: ${project}"; then
  fail "COMPOSE_PROJECT_NAME does not override the name in compose.yaml"
fi
if [[ ! -f .env ]]; then
  cp .env.example .env
  created_env=1
fi
api_port=$(env_value PULSE_API_PORT 3000)
status_port=$(env_value PULSE_STATUS_PORT 8080)
demo_status_port=$(env_value PULSE_DEMO_STATUS_PORT 8081)
checks_backup=$(mktemp)
cp "$checks_file" "$checks_backup"
docker compose --profile demo down -v --remove-orphans

step "Start the regular stack"
docker compose up -d --build
for service in api probe status notify; do
  wait_for "$T_UP" "$service is running" is_running "$service"
done
before=$(stack_snapshot)
window_end=$((SECONDS + STABLE_WINDOW))
while ((SECONDS < window_end)); do
  sleep "$POLL_INTERVAL"
  [[ "$(stack_snapshot)" == "$before" ]] || fail "a service restarted or changed state"
done
echo "ok: no restart or state change for ${STABLE_WINDOW}s"

step "First check result"
wait_for "$T_FIRST_RESULT" "status-page has a state other than unknown" check_state_known

step "Status page"
wait_for "$T_PAGE" "GET / on port ${status_port} returns the page and /api/checks lists 'Status page'" page_has_title

step "Incident"
docker compose stop status
wait_for "$T_INCIDENT_OPEN" "an incident is open" has_open_incident
incident_id=$(open_incident_id)
echo "incident: ${incident_id}"
docker compose start status
wait_for "$T_INCIDENT_RESOLVE" "incident ${incident_id} is resolved" is_incident_resolved "$incident_id"
wait_for "$T_NOTIFY" "notify ledger has ${incident_id}:opened" notify_has "${incident_id}:opened"
wait_for "$T_NOTIFY" "notify ledger has ${incident_id}:resolved" notify_has "${incident_id}:resolved"

step "Reload the checks"
jq '.checks += [{id: "e2e-api", name: "E2E api", url: "http://api:3000/checks", intervalMs: 10000, timeoutMs: 2000}]' \
  "$checks_backup" >"$checks_file"
docker compose restart api
wait_for "$T_UP" "api answers" api /checks
docker compose restart probe
wait_for "$T_RELOAD" "GET /checks lists e2e-api" has_check e2e-api
cp "$checks_backup" "$checks_file"

step "Persistence across down and up"
docker compose down
assert_volume api-data
assert_volume notify-data
docker compose up -d
wait_for "$T_UP" "api answers after up" api /checks
wait_for "$T_PAGE" "incident ${incident_id} is still listed" has_incident "$incident_id"

step "Demo profile"
docker compose --profile demo up -d demo-status
wait_for "$T_DEMO" "demo status page on port ${demo_status_port} returns 200" \
  is_http_200 "http://127.0.0.1:${demo_status_port}/"
# The documented cleanup. Not "down -v": the demo profile covers every service,
# so -v would also delete api-data and notify-data.
docker compose --profile demo rm -sf demo-init demo-api demo-targets demo-tls demo-probe-a demo-probe-b demo-status
docker volume rm "${project}_demo-api-data" "${project}_demo-config"
assert_no_volume demo-api-data
assert_no_volume demo-config
assert_volume api-data
assert_volume notify-data

step "All checks passed"
