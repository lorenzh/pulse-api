# shellcheck shell=bash
# history_covers_outage <start-ms> <end-ms> <interval-ms> < results.json
# Succeeds when, for every location in the results array on stdin, at least one result lies inside
# the outage [start, end], the timestamps are strictly ascending once sorted (no repeats), and no
# gap across [start - interval, end + interval], its edges included, exceeds 1.5 x the interval.
history_covers_outage() {
  jq -e --argjson start "$1" --argjson end "$2" --argjson interval "$3" '
    group_by(.location) as $groups
    | ($groups | length) > 0
    and all($groups[];
      [.[].timestamp | select(. >= $start - $interval and . <= $end + $interval)] | sort as $t
      | ($t == ($t | unique))
      and any($t[]; . >= $start and . <= $end)
      and ([$start - $interval] + $t + [$end + $interval]) as $p
      | all(range(1; $p | length); $p[.] - $p[. - 1] <= $interval * 1.5))' >/dev/null
}
