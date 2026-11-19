#!/usr/bin/env bash
# The four language suites (make typescript, python, go and rust), CAITLYN_SUITES_AT_ONCE at a time (default 4; 2
# where Docker has little memory), each in its own toolchain container with its own mock server. Each suite's output
# goes to build/suites/<lang>.log and is printed in full once it ends, so the four never interleave; the script fails
# if any suite failed, after all have ended, naming each one's exit code and time.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
at_once="${CAITLYN_SUITES_AT_ONCE:-4}"
mkdir -p build/suites
langs=(typescript python go rust)
pids=() names=() starts=()
results=()
finish() { # index
  local i="$1" rc=0 took
  wait "${pids[$i]}" || rc=$?
  # Each suite records when it ended, so its time is its own, not how long the script waited for it.
  took=$(( $(cat "build/suites/${names[$i]}.end") - ${starts[$i]} ))
  echo "===== ${names[$i]}: exit $rc after ${took}s ====="
  cat "build/suites/${names[$i]}.log"
  results+=("${names[$i]}=$rc (${took}s)")
  [ "$rc" = 0 ]
}
failed=0
next=0
for lang in "${langs[@]}"; do
  # At most at_once running: wait for the oldest before starting another.
  if [ "${#pids[@]}" -ge $(( next + at_once )) ]; then finish "$next" || failed=1; next=$(( next + 1 )); fi
  ( rc=0; scripts/docker.sh "scripts/test-$lang.sh" > "build/suites/$lang.log" 2>&1 || rc=$?; date +%s > "build/suites/$lang.end"; exit "$rc" ) &
  pids+=("$!") names+=("$lang") starts+=("$(date +%s)")
done
while [ "$next" -lt "${#pids[@]}" ]; do finish "$next" || failed=1; next=$(( next + 1 )); done
echo "suites: ${results[*]}"
exit "$failed"
