#!/usr/bin/env bash
# One command to run Dock: writes .env with fresh secrets on first run, starts
# the control plane, and with --host enrolls this machine as a host.
#
#   ./setup.sh                                   local, http://localhost:8088
#   ./setup.sh --host                            local + run docks on this machine (gVisor)
#   ./setup.sh --url https://dock.example.com    public, automatic HTTPS
#   ./setup.sh --ports-domain ports.example.com  serve dock ports at *.ports.example.com
#
#   ./setup.sh --build                           build images from this checkout instead of pulling
#   ./setup.sh --upgrade 0.2.0                   run release 0.2.0 (raises DOCK_VERSION in .env)
#
# Re-runs keep the existing .env and just pull (or rebuild) and restart the stack.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SELF_DIR}/../.." && pwd)"
DOCKLET_DIR="${DOCKLET_DIR:-${REPO_DIR}/../docklet}"
ENV_FILE="${SELF_DIR}/.env"
URL="http://localhost:8088"
URL_GIVEN=0
WITH_HOST=0
RUNTIME=""
ALLOW_VULNERABLE=""
PORTS_DOMAIN=""
BUILD=0
UPGRADE=""

log() { printf 'setup: %s\n' "$*"; }
die() {
  printf 'setup: ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: setup.sh [--url <public url>] [--host] [--build] [--upgrade <version>] [--runtime microvm|gvisor]
                [--ports-domain DOMAIN] [--allow-vulnerable NAMES]

  --url      origin users and hosts reach, default http://localhost:8088.
             A https:// DNS name gets a certificate automatically (ports 80/443).
  --build    build the images from this checkout (development) instead of
             pulling ghcr.io/usedock/* at DOCK_VERSION from .env.
  --upgrade  set DOCK_VERSION in .env to <version> (bare semver such as 0.2.0, no v)
             and pull and restart. Run `git pull` first for compose or Caddyfile changes.
  --host     also enroll this machine as a host (Linux, needs sudo).
  --runtime  host runtime for --host: gvisor (default) or microvm (Firecracker, needs /dev/kvm).
  --ports-domain
             serve exposed dock ports at <port>-<random>.DOMAIN; needs a wildcard
             DNS record *.DOMAIN pointing here. Local installs default to ports.localhost.
  --allow-vulnerable
             CPU vulnerabilities the host may run with (dev machines only),
             e.g. spec_rstack_overflow; passed to bootstrap-host.sh.

Environment: DOCKLET_DIR is the docklet checkout holding scripts/bootstrap-host.sh
(default: ../docklet, a usedock/docklet checkout next to this repository).
USAGE
}

# The fleet token is never printed (terminal scrollback, CI logs, shared
# sessions). Commands pass it as DOCKLET_FLEET_TOKEN, not argv, which ps shows.
print_next_steps() {
  cat <<DONE

Dock is running: ${PUBLIC_URL}
  Sign up there. Mail (sign-in codes, reset links) goes to the API log:
    docker compose -f ${SELF_DIR}/docker-compose.yml logs backend | grep -A2 "mail not delivered"
DONE
  [ "$WITH_HOST" != "1" ] || return 0
  printf '  To run docks, enroll a Linux machine. The fleet token is FLEET_TOKEN in %s; it is not shown here.\n' "$ENV_FILE"
  if [ -f "${DOCKLET_DIR}/scripts/bootstrap-host.sh" ]; then
    printf '  This machine: ./setup.sh --host, or by hand:\n'
    # shellcheck disable=SC2016
    printf '    DOCKLET_FLEET_TOKEN="$(sed -n '"'"'s/^FLEET_TOKEN=//p'"'"' "%s")" %s\n' "$ENV_FILE" '\'
    printf '      sudo --preserve-env=DOCKLET_FLEET_TOKEN bash "%s" --fleet-url %s --runtime gvisor\n' \
      "${DOCKLET_DIR}/scripts/bootstrap-host.sh" "$PUBLIC_URL"
  fi
  printf '  Another machine: print the token here with  grep ^FLEET_TOKEN= "%s"\n' "$ENV_FILE"
  printf '  then, from a usedock/docklet checkout on that machine, paste it at the silent prompt:\n'
  printf '    read -rs DOCKLET_FLEET_TOKEN && export DOCKLET_FLEET_TOKEN\n'
  printf '    sudo --preserve-env=DOCKLET_FLEET_TOKEN bash scripts/bootstrap-host.sh --fleet-url %s --runtime gvisor\n' "$PUBLIC_URL"
}

# check-setup-output.sh sets DOCK_SETUP_SOURCE_ONLY=1 to load the functions above only.
if [ "${DOCK_SETUP_SOURCE_ONLY:-}" = "1" ]; then
  return 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      [ "$#" -ge 2 ] || die "--url needs a value"
      URL="${2%/}"
      URL_GIVEN=1
      shift 2
      ;;
    --build)
      BUILD=1
      shift
      ;;
    --upgrade)
      [ "$#" -ge 2 ] || die "--upgrade needs a version"
      UPGRADE="$2"
      shift 2
      ;;
    --host)
      WITH_HOST=1
      shift
      ;;
    --runtime)
      [ "$#" -ge 2 ] || die "--runtime needs a value"
      RUNTIME="$2"
      shift 2
      ;;
    --allow-vulnerable)
      [ "$#" -ge 2 ] || die "--allow-vulnerable needs a value"
      ALLOW_VULNERABLE="$2"
      shift 2
      ;;
    --ports-domain)
      [ "$#" -ge 2 ] || die "--ports-domain needs a value"
      PORTS_DOMAIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

if [ -n "$UPGRADE" ]; then
  printf '%s' "$UPGRADE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || die "--upgrade needs a bare semver such as 0.2.0 (no leading v)"
  [ "$BUILD" = "0" ] || die "--upgrade and --build cannot be combined"
  [ -f "$ENV_FILE" ] || die "--upgrade needs an existing .env; run ./setup.sh first"
fi

# Check --host prerequisites before building the stack, not after.
if [ "$WITH_HOST" = "1" ]; then
  [ -f "${DOCKLET_DIR}/scripts/bootstrap-host.sh" ] || die "no docklet at ${DOCKLET_DIR}; clone https://github.com/usedock/docklet next to this repository or set DOCKLET_DIR"
  [ "$(uname -s)" = "Linux" ] || die "--host needs Linux; run docks on a Linux machine with ${DOCKLET_DIR}/scripts/bootstrap-host.sh"
fi

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon; start Docker or add yourself to the docker group"

secret() { openssl rand -hex 32; }

# Portable in-place KEY=value rewrite (BSD and GNU sed differ on -i).
set_env() {
  local tmp
  tmp="$(mktemp)"
  awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k, v; next } { print }' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

env_get() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}

# Like set_env, but appends keys an older .env does not have yet.
put_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    set_env "$1" "$2"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

# Hosted ports: the Caddy site for *.DOMAIN follows the public URL's scheme and port.
configure_ports() {
  local domain="$1" url scheme rest port=""
  printf '%s' "$domain" | grep -Eq '^([a-z0-9-]+\.)+[a-z]{2,63}$' || die "--ports-domain must be a lowercase domain such as ports.example.com"
  url="$(env_get DOCK_PUBLIC_URL)"
  scheme="${url%%://*}"
  rest="${url#*://}"
  rest="${rest%%/*}"
  if [ "$rest" != "${rest%%:*}" ]; then
    port=":${rest##*:}"
  fi
  put_env DOCK_PORTS_DOMAIN "$domain"
  if [ "$scheme" = "https" ]; then
    put_env DOCK_PORTS_SITE_ADDRESS "*.${domain}${port}"
  else
    put_env DOCK_PORTS_SITE_ADDRESS "http://*.${domain}${port:-:80}"
  fi
  log "dock ports will be served at <port>-<random>.${domain}"
}

write_env() {
  local scheme rest host port site admin key
  case "$URL" in
    http://*|https://*) ;;
    *) die "--url must start with http:// or https://" ;;
  esac
  scheme="${URL%%://*}"
  rest="${URL#*://}"
  rest="${rest%%/*}"
  host="${rest%%:*}"
  port=""
  if [ "$rest" != "$host" ]; then
    port="${rest##*:}"
  fi

  cp "${SELF_DIR}/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # Caddy listens on the site address port, so a port in the URL is bound 1:1 on the host.
  if [ "$scheme" = "https" ]; then
    site="$rest"
    if [ -n "$port" ]; then
      set_env DOCK_HTTPS_PORT "$port"
    fi
  else
    site="$URL"
    set_env DOCK_HTTP_PORT "${port:-80}"
    # Plain HTTP never serves 443; keep it free for anything else on this machine.
    set_env DOCK_HTTPS_PORT 8443
  fi
  set_env DOCK_SITE_ADDRESS "$site"
  set_env DOCK_PUBLIC_URL "$URL"
  for key in POSTGRES_PASSWORD BETTER_AUTH_SECRET SECRETS_ENCRYPTION_KEY FLEET_TOKEN SNAPSHOT_STORE_SECRET_KEY; do
    set_env "$key" "$(secret)"
  done
  admin="$(git -C "$REPO_DIR" config user.email 2>/dev/null || true)"
  if [ -n "$admin" ]; then
    set_env INSTANCE_ADMIN_EMAILS "$admin"
    log "instance admin: ${admin} (sign up with it and verify its email; with SMTP unset the link is in: docker compose logs backend)"
  fi
  if [ "$scheme" = "http" ] && [ "$host" != "localhost" ]; then
    log "note: plain HTTP on ${host}; GitHub webhooks and confined runs need https"
  fi
  log "wrote ${ENV_FILE} with fresh secrets (keep it; it holds SECRETS_ENCRYPTION_KEY and MINIO_KMS_SECRET_KEY)"
}

# Snapshot encryption key for MinIO's built-in KMS: <key-name>:<base64 of 32 bytes>.
# Generated once and never replaced, since a new key cannot read existing snapshots.
ensure_kms_key() {
  if [ -n "$(env_get MINIO_KMS_SECRET_KEY)" ]; then
    return
  fi
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the snapshot encryption key"
  put_env MINIO_KMS_SECRET_KEY "dock-snapshots:$(openssl rand -base64 32)"
  log "generated MINIO_KMS_SECRET_KEY in ${ENV_FILE}: snapshots are encrypted at rest with it."
  log "WARNING: back this key up (with .env). If it is lost, every snapshot becomes unreadable."
  if docker volume inspect dock_minio-data >/dev/null 2>&1; then
    log "note: snapshots written before this stay unencrypted until re-encrypted; see the self-hosting docs"
  fi
}

if [ -f "$ENV_FILE" ]; then
  log "using existing ${ENV_FILE}"
  if [ "$URL_GIVEN" = "1" ] && [ "$(env_get DOCK_PUBLIC_URL)" != "$URL" ]; then
    die "--url ${URL} differs from DOCK_PUBLIC_URL in .env; edit .env (or delete it to start over)"
  fi
else
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  write_env
fi

ensure_kms_key
PUBLIC_URL="$(env_get DOCK_PUBLIC_URL)"
if [ -n "$UPGRADE" ]; then
  log "DOCK_VERSION $(env_get DOCK_VERSION) -> ${UPGRADE}"
  put_env DOCK_VERSION "$UPGRADE"
fi
# An .env from before published images has no DOCK_VERSION; take the pinned one.
if [ -z "$(env_get DOCK_VERSION)" ]; then
  put_env DOCK_VERSION "$(sed -n 's/^DOCK_VERSION=//p' "${SELF_DIR}/.env.example" | head -n 1)"
fi
if [ -n "$PORTS_DOMAIN" ]; then
  configure_ports "$PORTS_DOMAIN"
elif [ -z "$(env_get DOCK_PORTS_DOMAIN)" ]; then
  # Browsers resolve *.localhost to this machine, so local installs need no DNS.
  case "$PUBLIC_URL" in
    http://localhost|http://localhost:*) configure_ports ports.localhost ;;
  esac
fi
FLEET_TOKEN="$(env_get FLEET_TOKEN)"

if [ "$BUILD" = "1" ]; then
  log "building and starting the control plane from source (first run takes a few minutes)"
  ( cd "$SELF_DIR" && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build )
else
  log "pulling dock $(env_get DOCK_VERSION) images and starting the control plane"
  ( cd "$SELF_DIR" && docker compose pull --quiet && docker compose up -d )
fi

log "waiting for ${PUBLIC_URL}/v1/health"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "${PUBLIC_URL}/v1/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = "1" ] || die "API not healthy at ${PUBLIC_URL}; check: docker compose -f ${SELF_DIR}/docker-compose.yml logs backend caddy"
log "control plane up at ${PUBLIC_URL}"

HOST_CMD=(bash "${DOCKLET_DIR}/scripts/bootstrap-host.sh" --fleet-url "$PUBLIC_URL" --fleet-token "$FLEET_TOKEN")
if [ "$WITH_HOST" = "1" ]; then
  case "${RUNTIME:-gvisor}" in
    gvisor) HOST_CMD+=(--runtime gvisor --pool-size 0) ;;
    microvm) HOST_CMD+=(--runtime microvm) ;;
    *) die "--runtime must be gvisor or microvm" ;;
  esac
  if [ -n "$ALLOW_VULNERABLE" ]; then
    HOST_CMD+=(--allow-vulnerable "$ALLOW_VULNERABLE")
  fi
  log "enrolling this machine as a host (sudo; first run builds the dock image)"
  if [ "$(id -u)" -eq 0 ]; then
    "${HOST_CMD[@]}"
  elif sudo -n true 2>/dev/null || [ -t 0 ]; then
    sudo "${HOST_CMD[@]}"
  else
    die "sudo needs a terminal to ask for your password; run this in a terminal: cd ${SELF_DIR} && ./setup.sh --host"
  fi
fi

print_next_steps
