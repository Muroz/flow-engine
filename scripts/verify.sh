#!/usr/bin/env bash
# Full check of the engine. Writes everything to runs/verify.log.
#
#   bash scripts/verify.sh          # offline: install, typecheck, tests, all three sample flows
#   bash scripts/verify.sh --live   # also one real review through OpenRouter (+ Jev if keyed). Costs cents.
set -u
cd "$(dirname "$0")/.."
mkdir -p runs
LOG=runs/verify.log
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm; else PNPM="corepack pnpm"; fi

step() { echo; echo "════ $1"; }
run() { "$@"; local c=$?; echo "── exit $c"; return 0; }

{
  step "environment"
  echo "date: $(date)"; echo "node: $(node -v)"; echo "pnpm: $($PNPM -v)"; uname -sm

  step "install";        run $PNPM install
  step "typecheck";      run $PNPM typecheck
  step "unit tests";     run $PNPM test
  step "review (offline, expect exit 2: sample diff is bad on purpose)"; run $PNPM review:sample
  step "deliver (offline, auto-approve)"; run $PNPM deliver:sample --yes
  step "plan (offline, auto-approve)";    run $PNPM plan:sample --yes

  if [ "${1:-}" = "--live" ]; then
    step "review (LIVE)"
    if [ -f .env ] && grep -q '^OPENROUTER_API_KEY=..*' .env; then
      run $PNPM flows review --repo examples/sample-project \
        --diff-file examples/sample-project/changes/T-002.diff --task T-002
    else
      echo "skipped: set OPENROUTER_API_KEY in .env first"
    fi
  fi

  step "done"
} 2>&1 | tee "$LOG"

echo; echo "Log written to $LOG"
