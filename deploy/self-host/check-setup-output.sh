#!/usr/bin/env bash
# CI check: setup.sh's closing output must never contain the fleet token.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN="dummytoken$(openssl rand -hex 16)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  printf 'check-setup-output: FAIL: %s\n' "$*" >&2
  exit 1
}

# Both branches: with and without a docklet checkout next to the repo.
mkdir -p "$WORK/docklet/scripts"
: > "$WORK/docklet/scripts/bootstrap-host.sh"
for dir in "$WORK/docklet" "$WORK/missing"; do
  out="$(
    DOCK_SETUP_SOURCE_ONLY=1 DOCKLET_DIR="$dir" bash -c '
      . "$1/setup.sh"
      PUBLIC_URL=https://dock.example.com WITH_HOST=0 FLEET_TOKEN="$2"
      print_next_steps
    ' _ "$SELF_DIR" "$TOKEN" 2>&1
  )"
  case "$out" in *"$TOKEN"*) fail "full fleet token printed (DOCKLET_DIR=$dir)" ;; esac
  case "$out" in *"--fleet-token"*"FLEET_TOKEN="*) ;; *) fail "next step does not read the token from .env" ;; esac
done
printf 'check-setup-output: ok\n'
