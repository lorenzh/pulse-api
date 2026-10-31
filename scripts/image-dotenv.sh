#!/usr/bin/env bash
# Proves that the API image reads no dotenv file, also not with its healthcheck.
# Usage: bash scripts/image-dotenv.sh <image>
# Each case runs in its own child process: bash ignores `set -e` inside `if`, `||` and `&&`.
set -uo pipefail

MARKER="dotenv-marker-556"
CASES=(control .env .env.production .env.local image-config)

write_fixture() {
  local dir="$1"
  mkdir -p "$dir/config"
  chmod 0755 "$dir" "$dir/config"
  printf '%s\n' '{"checks":[{"id":"ci","name":"CI","url":"http://127.0.0.1:9/","intervalMs":10000,"timeoutMs":2000}]}' >"$dir/config/checks.json"
  printf '%s\n' '{"tokens":[{"location":"ci","token":"dotenv-ci-0123456789abcdef"}]}' >"$dir/config/tokens.json"
  printf 'PULSE_LOG_LEVEL=%s\nPORT=1\n' "$MARKER" >"$dir/dotenv"
  chmod 0644 "$dir/config/checks.json" "$dir/config/tokens.json" "$dir/dotenv"
}

fixture_args() {
  local dir="$1"
  FIXTURE=(-v "$dir/config:/config:ro" -e PULSE_CHECKS_FILE=/config/checks.json -e PULSE_TOKENS_FILE=/config/tokens.json)
}

case_control() {
  local image="$1" dir="$2" err code=0
  err="$(timeout 30 docker run --rm "${FIXTURE[@]}" -e "PULSE_LOG_LEVEL=$MARKER" "$image" 2>&1 >/dev/null)" || code=$?
  if [ "$code" -ne 2 ]; then
    echo "reason: exit $code, expected 2" >&2
    return 1
  fi
  if ! grep -q PULSE_LOG_LEVEL <<<"$err"; then
    echo "reason: stderr has no PULSE_LOG_LEVEL" >&2
    return 1
  fi
}

show_failure() {
  local c="$1"
  echo "exit code: $(docker inspect --format '{{.State.ExitCode}}' "$c" 2>/dev/null)" >&2
  docker logs --tail 20 "$c" >&2 2>&1 || true
}

case_dotenv() {
  local image="$1" dir="$2" name="$3" c state i healthy=0
  c="pulse-dotenv-$$-${name#.}-$RANDOM"
  echo "$c" >>"$dir/containers"
  docker run -d --name "$c" "${FIXTURE[@]}" -v "$dir/dotenv:/app/$name:ro" "$image" >/dev/null
  local -a hc
  mapfile -t hc < <(docker image inspect "$image" | jq -r '.[0].Config.Healthcheck.Test[1:][]')
  for i in $(seq 60); do
    state="$(docker inspect --format '{{.State.Running}}' "$c")"
    if [ "$state" != "true" ]; then
      show_failure "$c"
      echo "reason: container exited $(docker inspect --format '{{.State.ExitCode}}' "$c")" >&2
      return 1
    fi
    if docker exec "$c" "${hc[@]}" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.5
  done
  if [ "$healthy" -ne 1 ]; then
    show_failure "$c"
    echo "reason: healthcheck did not pass within 30 s" >&2
    return 1
  fi
  docker exec "$c" sh -c "test -r /app/$name && test -s /app/$name"
  if docker logs "$c" 2>&1 | grep -q "$MARKER"; then
    echo "reason: logs contain the marker" >&2
    return 1
  fi
  docker stop -t 10 "$c" >/dev/null
  local code
  code="$(docker inspect --format '{{.State.ExitCode}}' "$c")"
  if [ "$code" != "0" ]; then
    show_failure "$c"
    echo "reason: stop exit code $code" >&2
    return 1
  fi
}

case_image_config() {
  local image="$1"
  docker image inspect "$image" | jq -e '.[0].Config.Cmd == ["bun","--no-env-file","src/main.ts"] and .[0].Config.Healthcheck.Test[0:4] == ["CMD","bun","--no-env-file","-e"]' >/dev/null
}

run_case() {
  set -euo pipefail
  local name="$1" image="$2" dir="$3"
  fixture_args "$dir"
  case "$name" in
    control) case_control "$image" "$dir" ;;
    .env | .env.production | .env.local) case_dotenv "$image" "$dir" "$name" ;;
    image-config) case_image_config "$image" ;;
    *)
      echo "unknown case $name" >&2
      exit 1
      ;;
  esac
}

if [ "${1:-}" = "--case" ]; then
  run_case "$2" "$3" "$4"
  exit 0
fi

image="${1:?usage: image-dotenv.sh <image>}"
dir="$(mktemp -d)"
cleanup() {
  if [ -f "$dir/containers" ]; then
    xargs -r docker rm -f <"$dir/containers" >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
}
trap cleanup EXIT
write_fixture "$dir"
: >"$dir/containers"

failed=0
for name in "${CASES[@]}"; do
  bash "$0" --case "$name" "$image" "$dir" 2>"$dir/case.err"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "ok: $name"
  else
    grep -v '^reason: ' "$dir/case.err" || true
    reason="$(grep '^reason: ' "$dir/case.err" | tail -1 | sed 's/^reason: //')"
    echo "FAIL: $name${reason:+: $reason}"
    failed=1
  fi
done
exit "$failed"
