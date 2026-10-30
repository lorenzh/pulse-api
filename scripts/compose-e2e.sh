#!/usr/bin/env bash
# End-to-end test of the Docker Compose stack. See docs/development.md.
# Needs Docker Compose >= 2.23, network access, curl and jq.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Always our own project: the teardown runs `down -v`, so an inherited
# COMPOSE_PROJECT_NAME such as `pulse` would delete real volumes.
export COMPOSE_PROJECT_NAME=pulse-e2e
project="$COMPOSE_PROJECT_NAME"
# The e2e fixtures live in compose.e2e.yaml, merged after compose.yaml for every call.
export COMPOSE_FILE=compose.yaml:compose.e2e.yaml

# Timeouts in seconds. Override them with environment variables.
T_UP="${E2E_TIMEOUT_UP:-600}"
T_FIRST_RESULT="${E2E_TIMEOUT_FIRST_RESULT:-90}"
T_PAGE="${E2E_TIMEOUT_PAGE:-60}"
T_INCIDENT_OPEN="${E2E_TIMEOUT_INCIDENT_OPEN:-120}"
T_INCIDENT_RESOLVE="${E2E_TIMEOUT_INCIDENT_RESOLVE:-120}"
T_NOTIFY="${E2E_TIMEOUT_NOTIFY:-60}"
T_RELOAD="${E2E_TIMEOUT_RELOAD:-60}"
T_DEMO="${E2E_TIMEOUT_DEMO:-300}"
T_REPLAY="${E2E_TIMEOUT_REPLAY:-120}"
# The api stays stopped longer than two intervals of the 10 s check (status-page).
OUTAGE_SECONDS="${E2E_OUTAGE_SECONDS:-35}"
STABLE_WINDOW="${E2E_STABLE_WINDOW:-12}"
POLL_INTERVAL="${E2E_POLL_INTERVAL:-2}"

regular_checks=compose/checks.json
e2e_checks=compose/e2e/checks.json
# A writable copy, mounted as a directory: the admin routes rename a new file over it.
rw_dir=compose/e2e/rw
checks_file=${rw_dir}/checks.json
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
  rm -rf "$rw_dir"
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

hb_secret="e2e-throwaway-heartbeat-secret"

hb_state_is() { # hb_state_is <state>
  [[ "$(api /checks | jq -r '.[] | select(.id == "heartbeat-e2e") | .state')" == "$1" ]]
}

hb_has_open_incident() {
  api /incidents | jq -e '[.[] | select(.checkId == "heartbeat-e2e" and .resolvedAt == null)] | length == 1'
}

hb_has_no_open_incident() {
  api /incidents | jq -e '[.[] | select(.checkId == "heartbeat-e2e" and .resolvedAt == null)] | length == 0'
}

hb_open_incident_id() {
  api /incidents | jq -re '[.[] | select(.checkId == "heartbeat-e2e" and .resolvedAt == null)] | first.id'
}

# Ping, then check at once: without pings the check goes down again after period + grace.
hb_ping_resolves() {
  curl -fsS --max-time 5 -o /dev/null -H "Authorization: Bearer ${hb_secret}" \
    "http://127.0.0.1:${api_port}/heartbeat/heartbeat-e2e" &&
    hb_state_is up && hb_has_no_open_incident
}

hb_metric_positive() { # hb_metric_positive <series>
  api /metrics | awk -v s="$1" '$1 == s"{check=\"heartbeat-e2e\"}" && $2 > 0 { found = 1 } END { exit !found }'
}

hb_status() { # hb_status <curl args...>: print the HTTP status
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"
}

hb_page_has_check() {
  curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/api/checks" | grep -qF 'Heartbeat e2e'
}

notify_has() {
  docker compose exec -T notify cat /data/incidents.jsonl | grep -qE -- "(^|[^0-9])$1"
}

# True once notify finished a good poll; that poll seeds the incidents that already exist.
# grep without -q reads all input, so pipefail never sees node die of SIGPIPE.
notify_has_polled() {
  docker compose exec -T notify bun -e \
    "fetch('http://127.0.0.1:9100/metrics').then(async (r) => console.log(await r.text()))" |
    grep -E '^pulse_notify_polls_total\{outcome="ok"\} [1-9]'
}

hb_has_new_incident() { # hb_has_new_incident <old id>
  local id
  id=$(hb_open_incident_id) && [[ "$id" != "$1" ]]
}

# The page is rendered in the browser from /api/checks, which the status
# service proxies from the API. So the check name is not in the HTML of GET /.
page_has_title() {
  curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/" | grep -qF 'id="checks"' &&
    curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/api/checks" | grep -qF 'Status page'
}

is_healthy() { # is_healthy <service>
  local id
  id=$(docker compose ps -q "$1")
  [[ -n "$id" && "$(docker inspect -f '{{.State.Health.Status}}' "$id")" == "healthy" ]]
}

api_healthz_ok() { [[ "$(api /healthz)" == "ok" ]]; }
api_readyz_ok() { [[ "$(api /readyz)" == "ok" ]]; }

api_metrics_ok() {
  local text
  text=$(api /metrics)
  grep -qx 'pulse_up 1' <<<"$text" &&
    grep -q '^pulse_api_check_state{check="status-page"' <<<"$text" &&
    grep -q '^pulse_api_http_requests_total{' <<<"$text"
}

exit_code_of() { # exit_code_of <service>
  docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -a -q "$1")"
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

e2e_admin_token="${E2E_ADMIN_TOKEN:-e2e-admin-token-sentinel-0123}"
manual_title='<script>alert(1)</script> Checkout slow'
escaped_title='&lt;script&gt;alert(1)&lt;/script&gt; Checkout slow'

# manual_code <method> <path> <body> <token>: print the HTTP status. Empty body or token: omitted.
manual_code() {
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 5 -X "$1")
  [[ -n "${4:-}" ]] && args+=(-H "Authorization: Bearer $4")
  [[ -n "${3:-}" ]] && args+=(-H 'Content-Type: application/json' -d "$3")
  curl "${args[@]}" "http://127.0.0.1:${api_port}$2"
}

# manual_call <method> <path> [body]: call with the admin token; print the body, fail on non-2xx.
manual_call() {
  local args=(-fsS --max-time 5 -X "$1" -H "Authorization: Bearer ${e2e_admin_token}")
  [[ -n "${3:-}" ]] && args+=(-H 'Content-Type: application/json' -d "$3")
  curl "${args[@]}" "http://127.0.0.1:${api_port}$2"
}

status_page() { curl -fsS --max-time 5 "http://127.0.0.1:${status_port}$1"; }

# The page is drawn in the browser from the proxied API, so the proxy and the feed are asserted here.
proxy_manual() { status_page /api/manual-incidents; }

proxy_shows_open_manual() {
  proxy_manual | jq -e --argjson id "$manual_id" --arg t "$manual_title" \
    '.[] | select(.id == $id and .title == $t and .resolvedAt == null and .impact == "major" and .componentIds == ["web"])'
}

proxy_has_text() { proxy_manual | grep -qF -- "$1"; }

proxy_shows_resolved_manual() {
  proxy_manual | jq -e --argjson id "$manual_id" '.[] | select(.id == $id and .resolvedAt != null and (.updates | length) == 3)'
}

feed_has() { status_page /feed.atom | grep -qF -- "$1"; }

manual_count() { # manual_count <file> <key>: lines of a notify channel file with the key
  docker compose exec -T notify cat "/data/$1" 2>/dev/null | grep -cF -- "\"key\":\"$2\"" || true
}

manual_sent() { [[ "$(manual_count "$1" "$2")" == "1" ]]; }

metric_is() { # metric_is <series> <value>
  api /metrics | grep -qx "$1 $2"
}

step "Setup (project ${project})"
for tool in docker curl jq openssl; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done
if ! docker compose config | grep -qx "name: ${project}"; then
  fail "COMPOSE_PROJECT_NAME does not override the name in compose.yaml"
fi
# The regular stack must carry no e2e fixture: only the e2e files may.
jq -e '[.checks[].id | select(test("e2e"))] | length == 0' "$regular_checks" >/dev/null ||
  fail "$regular_checks holds an e2e check"
echo "ok: $regular_checks holds no e2e check"
if [[ ! -f .env ]]; then
  # The example token is a placeholder the API rejects: write a random one.
  {
    sed '/^PULSE_PROBE_TOKEN=/d' .env.example
    printf 'PULSE_PROBE_TOKEN=%s\n' "$(openssl rand -hex 16)"
  } >.env
  created_env=1
fi
api_port=$(env_value PULSE_API_PORT 3000)
status_port=$(env_value PULSE_STATUS_PORT 8080)
demo_status_port=$(env_value PULSE_DEMO_STATUS_PORT 8081)
regular_services=$(COMPOSE_FILE=compose.yaml docker compose config --services | sort | paste -sd' ' -)
[[ "$regular_services" == "api notify probe status" ]] ||
  fail "the regular stack has the services: ${regular_services}"
regular_demo_services=$(COMPOSE_FILE=compose.yaml docker compose --profile demo config --services | sort | paste -sd' ' -)
# Hard-coded on purpose: a list derived from compose.yaml would accept any extra service.
expected_demo_services="api demo-api demo-init demo-probe-a demo-probe-b demo-status demo-targets demo-tls notify probe status"
[[ "$regular_demo_services" == "$expected_demo_services" ]] ||
  fail "the regular stack with the demo profile has the services: ${regular_demo_services} (expected: ${expected_demo_services})"
echo "ok: the regular stack has exactly api, notify, probe and status, plus the seven demo services"
# The api container runs as another user than the host: the directory must be open to it.
mkdir -p "$rw_dir"
chmod 777 "$rw_dir"
cp "$e2e_checks" "$checks_file"
chmod 666 "$checks_file"
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

step "Health and metrics"
for service in api probe status notify; do
  wait_for "$T_UP" "$service is healthy" is_healthy "$service"
done
wait_for "$T_UP" "GET /readyz on the api answers ok" api_readyz_ok
wait_for "$T_UP" "GET /healthz on the api answers ok" api_healthz_ok
wait_for "$T_UP" "GET /metrics on the api has the pulse_ series" api_metrics_ok

step "First check result"
wait_for "$T_FIRST_RESULT" "status-page has a state other than unknown" check_state_known

step "Status page"
wait_for "$T_PAGE" "GET / on port ${status_port} returns the page and /api/checks lists 'Status page'" page_has_title

e2e_token="${E2E_SVC_TOKEN:-e2e-svc-token-sentinel}"
e2e_body_sentinel="e2e-body-sentinel"

post_check_reason_is() { # post_check_reason_is <text>: the lastReason of the e2e-post check
  [[ "$(api /checks | jq -r '.[] | select(.id == "e2e-post") | .lastReason // ""')" == "$1" ]]
}

post_check_is() { # post_check_is <state>
  [[ "$(api /checks | jq -r '.[] | select(.id == "e2e-post") | .state')" == "$1" ]]
}

set_target_mode() { # set_target_mode <mode>
  docker compose exec -T e2e-target bun -e \
    "fetch('http://127.0.0.1:8000/mode/$1', { method: 'POST' }).then((r) => process.exit(r.status === 204 ? 0 : 1))"
}

# None of the strings may appear in the text of a response or a log.
assert_absent() { # assert_absent <description> <text>
  local needle
  for needle in "$e2e_token" "$e2e_body_sentinel" PULSE_HEADER_SVC_TOKEN; do
    if grep -qF -- "$needle" <<<"$2"; then fail "$1 shows ${needle}"; fi
  done
  echo "ok: $1 shows no secret"
}

check_state_is() { # check_state_is <id> <state>
  [[ "$(api /checks | jq -r --arg id "$1" '.[] | select(.id == $id) | .state')" == "$2" ]]
}

closed_port_reason_names_refusal() {
  api /checks | jq -e '.[] | select(.id == "e2e-tcp-closed" and .state == "down" and ((.lastReason // "") | test("refused|ECONNREFUSED")))' >/dev/null
}

step "TCP and DNS checks"
wait_for "$T_FIRST_RESULT" "e2e-tcp is up" check_state_is e2e-tcp up
wait_for "$T_FIRST_RESULT" "e2e-dns is up" check_state_is e2e-dns up
wait_for "$T_FIRST_RESULT" "e2e-tcp-closed is down and the reason names the refusal" closed_port_reason_names_refusal

step "HTTP check with method, headers, body and JSON assertions"
wait_for "$T_FIRST_RESULT" "e2e-post is up" post_check_is up
[[ "$(hb_status "http://127.0.0.1:${api_port}/probe/checks")" == "401" ]] ||
  fail "GET /probe/checks without a token did not answer 401"
echo "ok: GET /probe/checks needs a token"
api /components | jq -e '[.[].id] == ["web", "public-api"]' >/dev/null ||
  fail "GET /components does not list web and public-api in order"
api /components/uptime | jq -e '[.[].componentId] == ["web", "public-api"]' >/dev/null ||
  fail "GET /components/uptime does not list web and public-api in order"
echo "ok: GET /components and /components/uptime list both components"
set_target_mode degraded
wait_for "$T_INCIDENT_OPEN" "e2e-post is down for a changed JSON value" \
  post_check_reason_is 'json /status: expected "ok", got "degraded"'
set_target_mode 503
wait_for "$T_INCIDENT_OPEN" "e2e-post is down for status 503" post_check_reason_is "HTTP 503 not in 200"
set_target_mode text
wait_for "$T_INCIDENT_OPEN" "e2e-post is down for a body that is not JSON" post_check_reason_is "json: invalid body"
set_target_mode ok
wait_for "$T_INCIDENT_RESOLVE" "e2e-post is up again" post_check_is up
assert_absent "GET /checks" "$(api /checks)"
assert_absent "GET /metrics" "$(api /metrics)"
assert_absent "the status page proxy" "$(curl -fsS --max-time 5 "http://127.0.0.1:${status_port}/api/checks")"
assert_absent "the container logs" "$(docker compose logs --no-color)"

step "Heartbeat check"
wait_for "$T_INCIDENT_OPEN" "heartbeat-e2e is down without a ping" hb_state_is down
wait_for "$T_INCIDENT_OPEN" "heartbeat-e2e has one open incident" hb_has_open_incident
wait_for "$T_INCIDENT_OPEN" "pulse_heartbeat_missed_total is above 0" hb_metric_positive pulse_heartbeat_missed_total
[[ -z "$(api /metrics | awk '$1 == "pulse_heartbeat_pings_total{check=\"heartbeat-e2e\"}" && $2 > 0')" ]] ||
  fail "pulse_heartbeat_pings_total is above 0 before a ping"
echo "ok: pulse_heartbeat_pings_total is 0 before a ping"
api /checks | grep -qF "$hb_secret" && fail "GET /checks shows the heartbeat secret"
echo "ok: the secret is absent from GET /checks"
wait_for "$T_PAGE" "the status page lists the heartbeat check" hb_page_has_check
[[ "$(hb_status -H 'Authorization: Bearer wrong-secret-0123456789' "http://127.0.0.1:${api_port}/heartbeat/heartbeat-e2e")" == "401" ]] ||
  fail "a wrong secret did not answer 401"
[[ "$(hb_status "http://127.0.0.1:${api_port}/heartbeat/no-such-check/${hb_secret}")" == "401" ]] ||
  fail "an unknown id did not answer 401"
echo "ok: a wrong secret and an unknown id answer 401"
# The first incident can open before notify's first poll, which seeds it without an
# `opened` event. Resolve it, and assert on the next incident, opened after that poll.
hb_first_incident_id=$(hb_open_incident_id)
wait_for "$T_NOTIFY" "notify has polled the api" notify_has_polled
wait_for "$T_INCIDENT_RESOLVE" "a ping with the header secret brings the check up and resolves the incident" hb_ping_resolves
wait_for "$T_INCIDENT_OPEN" "heartbeat-e2e opens a new incident without a ping" hb_has_new_incident "$hb_first_incident_id"
hb_incident_id=$(hb_open_incident_id)
wait_for "$T_NOTIFY" "notify ledger has ${hb_incident_id}:opened" notify_has "${hb_incident_id}:opened"
wait_for "$T_INCIDENT_RESOLVE" "a ping resolves incident ${hb_incident_id}" hb_ping_resolves
wait_for "$T_NOTIFY" "notify ledger has ${hb_incident_id}:resolved" notify_has "${hb_incident_id}:resolved"
wait_for "$T_INCIDENT_OPEN" "pulse_heartbeat_pings_total is above 0" hb_metric_positive pulse_heartbeat_pings_total
[[ "$(hb_status -X POST "http://127.0.0.1:${api_port}/heartbeat/heartbeat-e2e/${hb_secret}")" == "204" ]] ||
  fail "a ping with the path secret did not answer 204"
echo "ok: both ping forms answer 204"

step "Incident"
docker compose stop status
wait_for "$T_INCIDENT_OPEN" "an incident is open" has_open_incident
incident_id=$(open_incident_id)
echo "incident: ${incident_id}"
docker compose start status
wait_for "$T_INCIDENT_RESOLVE" "incident ${incident_id} is resolved" is_incident_resolved "$incident_id"
wait_for "$T_NOTIFY" "notify ledger has ${incident_id}:opened" notify_has "${incident_id}:opened"
wait_for "$T_NOTIFY" "notify ledger has ${incident_id}:resolved" notify_has "${incident_id}:resolved"

step "Manual incidents"
probe_token=$(env_value PULSE_PROBE_TOKEN "")
body='{"title":"T","impact":"major","componentIds":["web"],"message":"m"}'
[[ "$(manual_code POST /manual-incidents "$body" "")" == "401" ]] || fail "an unauthenticated write was not refused"
[[ "$(manual_code POST /manual-incidents "$body" "$probe_token")" == "401" ]] || fail "a probe token write was not refused"
echo "ok: writes without a token and with a probe token answer 401"
[[ "$(manual_code POST /manual-incidents '{"title":"T","impact":"major","componentIds":["nope"],"message":"m"}' "$e2e_admin_token")" == "400" ]] ||
  fail "an unknown component was accepted"
long_title=$(printf 'x%.0s' $(seq 1 201))
[[ "$(manual_code POST /manual-incidents "{\"title\":\"${long_title}\",\"impact\":\"none\",\"componentIds\":[],\"message\":\"m\"}" "$e2e_admin_token")" == "400" ]] ||
  fail "an over-long title was accepted"
long_message=$(printf 'x%.0s' $(seq 1 2001))
[[ "$(manual_code POST /manual-incidents "{\"title\":\"T\",\"impact\":\"none\",\"componentIds\":[],\"message\":\"${long_message}\"}" "$e2e_admin_token")" == "400" ]] ||
  fail "an over-long message was accepted"
echo "ok: an unknown component and over-long text are rejected"
[[ "$(api /manual-incidents | jq 'length')" == "0" ]] || fail "a rejected write was stored"

wait_for "$T_NOTIFY" "notify has polled the api" notify_has_polled
created=$(manual_call POST /manual-incidents "$(jq -nc --arg t "$manual_title" \
  '{title: $t, impact: "major", componentIds: ["web"], message: "Investigating <b>now</b>"}')")
manual_id=$(jq -re '.id' <<<"$created")
echo "manual incident: ${manual_id}"
wait_for "$T_PAGE" "the status service serves the open manual incident (hide-details is on by default)" proxy_shows_open_manual
wait_for "$T_PAGE" "the feed has manual:${manual_id}:0" feed_has "manual:${manual_id}:0"
wait_for "$T_PAGE" "the feed escapes the title" feed_has "$escaped_title"
if status_page /feed.atom | grep -qF '<script>alert(1)'; then fail "the feed holds unescaped HTML"; fi
echo "ok: the feed holds no raw <script>"
wait_for "$T_NOTIFY" "notify sent manual:${manual_id}:opened to the web channel" \
  manual_sent manual-web.jsonl "manual:${manual_id}:opened"

sleep 1
manual_call POST "/manual-incidents/${manual_id}/updates" '{"status":"identified","message":"Cause found."}' >/dev/null
wait_for "$T_NOTIFY" "notify sent manual:${manual_id}:update:1" manual_sent manual-web.jsonl "manual:${manual_id}:update:1"
wait_for "$T_PAGE" "the status service serves the latest update" proxy_has_text "Cause found."
sleep 1
manual_call POST "/manual-incidents/${manual_id}/updates" '{"status":"resolved","message":"Fixed."}' >/dev/null
wait_for "$T_NOTIFY" "notify sent manual:${manual_id}:resolved" manual_sent manual-web.jsonl "manual:${manual_id}:resolved"

manual_list=$(api /manual-incidents)
jq -e --argjson id "$manual_id" '
  .[] | select(.id == $id) | .status == "resolved" and .resolvedAt != null
    and ([.updates[].message] == ["Investigating <b>now</b>", "Cause found.", "Fixed."])
    and ([.updates[].at] == ([.updates[].at] | sort))
    and .updates[-1].at == .resolvedAt' <<<"$manual_list" >/dev/null ||
  fail "GET /manual-incidents does not list the incident with its updates in time order"
echo "ok: GET /manual-incidents lists the resolved incident with three updates in time order"
wait_for "$T_PAGE" "the status service serves the resolved incident with all updates" proxy_shows_resolved_manual
wait_for "$T_PAGE" "the feed has manual:${manual_id}:2" feed_has "manual:${manual_id}:2"

[[ "$(manual_count manual-public-api.jsonl "manual:${manual_id}:opened")" == "0" ]] ||
  fail "the public-api channel got an incident of component web"
echo "ok: component routing: web channel got the events, public-api channel none"
for key in opened update:1 resolved; do
  [[ "$(manual_count incidents.jsonl "manual:${manual_id}:${key}")" == "1" ]] ||
    fail "the catch-all channel does not hold manual:${manual_id}:${key} exactly once"
done
echo "ok: one ledger entry per event, sent once"

docker compose restart notify
wait_for "$T_UP" "notify is healthy after the restart" is_healthy notify
wait_for "$T_NOTIFY" "notify has polled again" notify_has_polled
sleep $((POLL_INTERVAL * 3))
for key in opened update:1 resolved; do
  [[ "$(manual_count manual-web.jsonl "manual:${manual_id}:${key}")" == "1" ]] ||
    fail "manual:${manual_id}:${key} was sent again after a notify restart"
done
echo "ok: a notify restart sends nothing twice"

metric_is pulse_api_manual_incidents_created_total 1 || fail "pulse_api_manual_incidents_created_total is not 1"
metric_is pulse_api_manual_incidents_resolved_total 1 || fail "pulse_api_manual_incidents_resolved_total is not 1"
echo "ok: metrics count one created and one resolved"
[[ "$(manual_code DELETE "/manual-incidents/${manual_id}" "" "$e2e_admin_token")" == "204" ]] || fail "DELETE did not answer 204"
[[ "$(api /manual-incidents | jq 'length')" == "0" ]] || fail "the deleted incident is still listed"
[[ "$(manual_code GET "/manual-incidents/${manual_id}" "" "")" == "404" ]] || fail "the deleted incident is still readable"
echo "ok: delete removes the incident from reads"
assert_absent "GET /metrics" "$(api /metrics)"
if grep -qF -- "$e2e_admin_token" <<<"$(docker compose logs --no-color)"; then fail "the logs show the admin token"; fi
echo "ok: the container logs show no admin token"

# shellcheck source=scripts/outage-history.sh
source scripts/outage-history.sh

# outage_replayed <start-ms> <end-ms>: the stored status-page history covers the outage.
outage_replayed() {
  api "/checks/status-page/results?limit=200" | history_covers_outage "$1" "$2" 10000
}

locations_report() {
  api /locations | jq -e 'length > 0 and all(.[]; .state == "reporting")'
}

step "Probe outage: buffered results are replayed"
outage_start=$(($(date +%s) * 1000))
docker compose stop api
sleep "$OUTAGE_SECONDS"
docker compose start api
outage_end=$(($(date +%s) * 1000))
wait_for "$T_UP" "api answers after the outage" api /checks
wait_for "$T_REPLAY" "GET /locations shows the probe location reporting" locations_report
wait_for "$T_REPLAY" "status-page results cover the outage without a gap" outage_replayed "$outage_start" "$outage_end"

cfg_url="http://127.0.0.1:${api_port}"

cfg_etag() { # the current revision, quoted
  curl -fsS --max-time 5 -D - -o /dev/null -H "Authorization: Bearer ${e2e_admin_token}" "${cfg_url}/admin/config" |
    tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p'
}

cfg_code() { # cfg_code <method> <path> [body]: send with the current revision; print the status
  local args=(-sS --max-time 5 -o /dev/null -w '%{http_code}' -X "$1"
    -H "Authorization: Bearer ${e2e_admin_token}" -H "If-Match: $(cfg_etag)")
  if [[ -n "${3:-}" ]]; then args+=(-H 'Content-Type: application/json' -d "$3"); fi
  curl "${args[@]}" "${cfg_url}$2"
}

check_has_result() { api "/checks/$1/results?limit=1" | jq -e 'length > 0'; }
page_has_check_name() { status_page /api/checks | grep -qF -- "$1"; }
page_lacks_check_name() { ! page_has_check_name "$1"; }

step "Checks via the admin API and hot reload"
new_check='{"id":"e2e-api","name":"E2E api","url":"http://api:3000/checks","intervalMs":10000,"timeoutMs":2000}'
[[ "$(cfg_code POST /admin/checks "$new_check")" == "201" ]] || fail "POST /admin/checks did not answer 201"
wait_for "$T_RELOAD" "GET /checks lists e2e-api" has_check e2e-api
# The probe fetches its checks every 60 s.
wait_for $((T_RELOAD * 2)) "a probe reported e2e-api" check_has_result e2e-api
[[ "$(cfg_code POST /admin/checks "$new_check")" == "409" ]] || fail "a repeated POST did not answer 409"
renamed=${new_check/\"E2E api\"/\"E2E api renamed\"}
[[ "$(cfg_code PUT /admin/checks/e2e-api "$renamed")" == "200" ]] || fail "PUT /admin/checks/e2e-api did not answer 200"
wait_for "$T_PAGE" "the status page shows the new name" page_has_check_name "E2E api renamed"
[[ "$(cfg_code DELETE /admin/checks/e2e-api)" == "204" ]] || fail "DELETE /admin/checks/e2e-api did not answer 204"
wait_for "$T_PAGE" "the status page drops the check" page_lacks_check_name "E2E api renamed"
metric_line=$(api /metrics | grep '^pulse_api_config_writes_total{kind="check",action="create",result="ok"}')
[[ "$metric_line" == *" 1" ]] || fail "the create counter is not 1: ${metric_line}"
echo "ok: create, replace and delete through the API reach the probe and the status page"

jq '.checks += [{id: "e2e-hup", name: "E2E hup", url: "http://api:3000/checks", intervalMs: 10000, timeoutMs: 2000}]' \
  "$checks_backup" >"${checks_file}.new"
cat "${checks_file}.new" >"$checks_file"
rm -f "${checks_file}.new"
docker compose kill -s HUP api
wait_for "$T_RELOAD" "SIGHUP applies a hand edit: GET /checks lists e2e-hup" has_check e2e-hup
cp "$checks_backup" "$checks_file"
wait_for "$T_RELOAD" "the polling reload drops e2e-hup" bash -c "! curl -fsS http://127.0.0.1:${api_port}/checks | jq -e '.[] | select(.id == \"e2e-hup\")'"

# The regular mount is read-only: a second api on another port answers 503 to a write.
ro_js='const r = await fetch("http://127.0.0.1:3999/admin/checks", { method: "POST", headers: { authorization: "Bearer " + process.env.E2E_TOKEN, "if-match": "\"sha256-" + "0".repeat(64) + "\"", "content-type": "application/json" }, body: "{}" }); console.log(r.status);'
ro_status=$(docker compose exec -T -e PORT=3999 -e PULSE_DB=/tmp/ro.db -e PULSE_CHECKS_FILE=/config/checks.json \
  -e E2E_TOKEN="$e2e_admin_token" -e RO_JS="$ro_js" api \
  sh -c 'bun src/main.ts >/dev/null 2>&1 & pid=$!; sleep 4; bun -e "$RO_JS"; kill $pid' | tail -n 1 || true)
[[ "$ro_status" == "503" ]] || fail "a write to the read-only mount did not answer 503 (got: ${ro_status})"
echo "ok: the read-only mount answers 503"

step "Persistence across down and up"
docker compose down
assert_volume api-data
assert_volume notify-data
docker compose up -d
wait_for "$T_UP" "api answers after up" api /checks
wait_for "$T_PAGE" "incident ${incident_id} is still listed" has_incident "$incident_id"
# The probe starts only after the api is healthy; a SIGTERM before its handlers exist would be ignored.
for service in api probe status notify; do
  wait_for "$T_UP" "$service is healthy after up" is_healthy "$service"
done

step "Clean stop"
# docker stop sends SIGTERM and kills after the timeout: exit 0 means the service stopped by itself.
docker compose stop -t 10 api probe status notify
for service in api probe status notify; do
  [[ "$(exit_code_of "$service")" == "0" ]] || fail "$service did not exit with code 0 on docker stop"
  echo "ok: $service exited with code 0"
done

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
