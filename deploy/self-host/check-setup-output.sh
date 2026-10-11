#!/usr/bin/env bash
# CI check: setup.sh's closing output never contains the fleet token, and the
# enroll commands it prints hand the token to bootstrap-host.sh via the environment.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN="dummytoken$(openssl rand -hex 16)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  printf 'check-setup-output: FAIL: %s\n' "$*" >&2
  exit 1
}

printf 'FLEET_TOKEN=%s\n' "$TOKEN" > "$WORK/.env"
# Stub bootstrap-host.sh records what it received.
mkdir -p "$WORK/docklet/scripts" "$WORK/bin"
cat > "$WORK/docklet/scripts/bootstrap-host.sh" <<STUB
printf '%s\n' "\${DOCKLET_FLEET_TOKEN:-}" > "$WORK/got-env"
printf '%s\n' "\$*" > "$WORK/got-argv"
STUB
# Stub sudo resets the environment like env_reset, keeping only --preserve-env names.
cat > "$WORK/bin/sudo" <<'STUB'
#!/usr/bin/env bash
keep=(PATH="$PATH")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preserve-env=*) IFS=, read -ra names <<< "${1#*=}"; for n in "${names[@]}"; do keep+=("$n=${!n:-}"); done; shift ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec env -i "${keep[@]}" "$@"
STUB
chmod +x "$WORK/bin/sudo"

# Runs a printed command block and checks the token arrived in the env, not argv.
run_block() {
  local name="$1" dir="$2" block="$3" input="${4:-}"
  rm -f "$WORK/got-env" "$WORK/got-argv"
  [ -n "$block" ] || fail "$name: no command printed"
  ( cd "$dir" && printf '%s\n' "$input" | PATH="$WORK/bin:$PATH" bash -c "$block" ) || fail "$name: command failed"
  [ "$(cat "$WORK/got-env" 2>/dev/null)" = "$TOKEN" ] || fail "$name: bootstrap-host.sh did not get the token in DOCKLET_FLEET_TOKEN"
  case "$(cat "$WORK/got-argv")" in *"$TOKEN"*) fail "$name: token passed in argv" ;; esac
}

# Both branches: with and without a docklet checkout next to the repo.
for dir in "$WORK/docklet" "$WORK/missing"; do
  out="$(
    DOCK_SETUP_SOURCE_ONLY=1 DOCKLET_DIR="$dir" bash -c '
      . "$1/setup.sh"
      PUBLIC_URL=https://dock.example.com WITH_HOST=0 FLEET_TOKEN="$2" ENV_FILE="$3/.env"
      print_next_steps
    ' _ "$SELF_DIR" "$TOKEN" "$WORK" 2>&1
  )"
  case "$out" in *"$TOKEN"*) fail "full fleet token printed (DOCKLET_DIR=$dir)" ;; esac

  local_block="$(printf '%s\n' "$out" | sed -n '/^  This machine:/,/^  Another machine:/p' | sed '1d;$d')"
  if [ "$dir" = "$WORK/docklet" ]; then
    run_block "this machine" "$WORK" "$local_block"
  else
    [ -z "$local_block" ] || fail "this-machine command printed without a docklet checkout"
  fi

  show="$(printf '%s\n' "$out" | sed -n 's/.*print the token here with  //p')"
  [ -n "$show" ] || fail "no command to show the token on the control plane"
  [ "$(bash -c "$show")" = "FLEET_TOKEN=$TOKEN" ] || fail "show-token command does not print FLEET_TOKEN"
  remote_block="$(printf '%s\n' "$out" | sed -n '/silent prompt:/,$p' | sed '1d')"
  run_block "another machine" "$WORK/docklet" "$remote_block" "$TOKEN"
done
printf 'check-setup-output: ok\n'
