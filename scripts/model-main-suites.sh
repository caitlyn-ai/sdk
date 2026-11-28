#!/usr/bin/env bash
# The four language suites (scripts/test-typescript.sh, test-python.sh, test-go.sh and test-rust.sh) at once, as
# model:main runs them (scripts/model-main.sh): about 220 s on the arm64 runner, against about 620 s one after another.
# Each writes its own log, build/model-main/<suite>.log; once all have ended, each log is printed in turn in its own
# collapsible section, and the run fails, naming them, if any of them failed. Every suite runs to its end even when
# another fails, so one run shows every failure.
#
# They share nothing that one writes while another reads:
#   - each conformance harness's mock server takes a port from its own range (TypeScript 4101 and 4102, or 4100 to
#     4599 when it starts its own; Python 4600 to 4899; Go 4900 to 5049; Rust 5050 to 5199), which
#     scripts/model-main-suites.test.mjs keeps apart;
#   - build/model/model.json, which every suite prepares again, is written atomically (scripts/prepare-model.mjs), so
#     a suite reading it never sees another's half-written file; model:main prepares it once before this anyway;
#   - each language's build output, caches and reports are its own (typescript/, python/, go/, rust/, and
#     build/conformance/<suite>*).
#
#   scripts/model-main-suites.sh [suite …]    the suites to run (default: all four)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
suites=("$@")
[ ${#suites[@]} -gt 0 ] || suites=(typescript python go rust)
logs=build/model-main
mkdir -p "$logs"
start=$(date +%s)
pids=()
for suite in "${suites[@]}"; do
  ( s=$(date +%s); scripts/"test-${suite}.sh"; rc=$?; echo "$suite: exit $rc after $(( $(date +%s) - s )) s"; exit $rc ) > "$logs/$suite.log" 2>&1 &
  pids+=($!)
done
failed=()
for i in "${!suites[@]}"; do
  wait "${pids[$i]}" || failed+=("${suites[$i]}")
done
for suite in "${suites[@]}"; do
  # A GitLab collapsible section per suite (collapsed when it passed)
  collapsed=true
  for f in ${failed[@]+"${failed[@]}"}; do [ "$f" = "$suite" ] && collapsed=false; done
  printf '\e[0Ksection_start:%s:suite_%s[collapsed=%s]\r\e[0K%s\n' "$(date +%s)" "$suite" "$collapsed" "scripts/test-${suite}.sh"
  cat "$logs/$suite.log"
  printf '\e[0Ksection_end:%s:suite_%s\r\e[0K\n' "$(date +%s)" "$suite"
done
echo "The suites took $(( $(date +%s) - start )) s at once: ${suites[*]}."
if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]} (their logs are above, and in ${logs}/)." >&2
  exit 1
fi
