#!/usr/bin/env bash
# CI check for the self-host compose file, run with a throwaway .env and project.
#
#   ./check-compose.sh          static: the snapshot encryption key reaches only minio
#   ./check-compose.sh --live   also boots minio + minio-init and proves SSE-S3 end to end,
#                               including an upgrade from an unencrypted volume
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "${SELF_DIR}/check-setup-output.sh"
PROJECT="dock-compose-check"
WORK="$(mktemp -d)"
KMS_KEY="dock-snapshots:$(openssl rand -base64 32)"
ROOT_USER=dock
ROOT_PASS="$(openssl rand -hex 16)"
BUCKET=dock-snapshots
PY="$(command -v python3 || command -v python)"

fail() {
  printf 'check-compose: FAIL: %s\n' "$*" >&2
  exit 1
}
log() { printf 'check-compose: %s\n' "$*"; }

cp -r "${SELF_DIR}/docker-compose.yml" "${SELF_DIR}/Caddyfile" "${SELF_DIR}/ports-tls" "$WORK/"
sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 8)|" \
  -e "s|^FLEET_TOKEN=.*|FLEET_TOKEN=$(openssl rand -hex 8)|" \
  -e "s|^SNAPSHOT_STORE_ACCESS_KEY=.*|SNAPSHOT_STORE_ACCESS_KEY=${ROOT_USER}|" \
  -e "s|^SNAPSHOT_STORE_SECRET_KEY=.*|SNAPSHOT_STORE_SECRET_KEY=${ROOT_PASS}|" \
  -e "s|^DOCK_PUBLIC_URL=.*|DOCK_PUBLIC_URL=http://localhost:8088|" \
  -e "s|^DOCK_SITE_ADDRESS=.*|DOCK_SITE_ADDRESS=http://localhost:8088|" \
  "${SELF_DIR}/.env.example" | tr -d '\r' > "$WORK/.env"
grep -q '^MINIO_KMS_SECRET_KEY=$' "$WORK/.env" || fail ".env.example has no empty MINIO_KMS_SECRET_KEY"

compose() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/docker-compose.yml" "$@"; }

# A missing key must stop compose with a pointer to setup.sh, not start MinIO without SSE.
if out="$(compose config 2>&1)"; then
  fail "compose config accepted an .env without MINIO_KMS_SECRET_KEY"
fi
printf '%s' "$out" | grep -q 'setup.sh' || fail "missing-key error does not point at setup.sh: $out"

printf 'MINIO_KMS_SECRET_KEY=%s\n' "$KMS_KEY" >> "$WORK/.env"
sed -i.bak '/^MINIO_KMS_SECRET_KEY=$/d' "$WORK/.env"

# Only minio may hold the key; backend gets all of .env through env_file.
holders="$(compose config --format json | "$PY" -c '
import json, sys
key = sys.argv[1]
services = json.load(sys.stdin)["services"]
print(" ".join(sorted(n for n, s in services.items() if key in json.dumps(s))))
' "${KMS_KEY#*:}")"
[ "$holders" = "minio" ] || fail "snapshot encryption key reaches: ${holders} (want only minio)"
log "static: key reaches only minio; missing key fails with an actionable error"

[ "${1:-}" = "--live" ] || exit 0

cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; docker rm -f "${PROJECT}-old" >/dev/null 2>&1 || true; docker network rm "${PROJECT}-old" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

MINIO_IMAGE="$(compose config --format json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["services"]["minio"]["image"])')"
MC_IMAGE="$(compose config --format json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["services"]["minio-init"]["image"])')"
VOLUME="${PROJECT}_minio-data"

mc() { compose run --rm -T --no-deps --entrypoint /bin/sh minio-init -c "mc alias set dock http://minio:9000 '$ROOT_USER' '$ROOT_PASS' >/dev/null && $1"; }

# An install from before this change: MinIO without a KMS key holding a plaintext object.
compose create minio >/dev/null
docker network create "${PROJECT}-old" >/dev/null
docker run -d --name "${PROJECT}-old" --network "${PROJECT}-old" --network-alias minio \
  -e MINIO_ROOT_USER="$ROOT_USER" -e MINIO_ROOT_PASSWORD="$ROOT_PASS" -v "${VOLUME}:/data" \
  "$MINIO_IMAGE" server /data >/dev/null
for _ in $(seq 1 30); do
  docker run --rm --network "${PROJECT}-old" --entrypoint /bin/sh "$MC_IMAGE" -c \
    "mc alias set dock http://minio:9000 '$ROOT_USER' '$ROOT_PASS' >/dev/null && mc mb --ignore-existing dock/${BUCKET} >/dev/null && echo before-upgrade | mc pipe dock/${BUCKET}/old.txt >/dev/null" && break
  sleep 2
done
docker rm -f "${PROJECT}-old" >/dev/null
docker network rm "${PROJECT}-old" >/dev/null

# Upgrade: start the stack's minio with the key; minio-init must succeed.
compose up --exit-code-from minio-init minio-init || fail "minio-init failed"

mc "mc encrypt info dock/${BUCKET}" | tee "$WORK/info.txt"
grep -qi 'sse-s3' "$WORK/info.txt" || fail "bucket default encryption is not sse-s3"

mc "echo after-upgrade | mc pipe dock/${BUCKET}/new.txt >/dev/null"
[ "$(mc "mc cat dock/${BUCKET}/new.txt")" = "after-upgrade" ] || fail "new object did not round-trip"
[ "$(mc "mc cat dock/${BUCKET}/old.txt")" = "before-upgrade" ] || fail "pre-upgrade object unreadable"
mc "mc stat --json dock/${BUCKET}/new.txt" | grep -qi 'server-side-encryption' || fail "new object is not encrypted"
if mc "mc stat --json dock/${BUCKET}/old.txt" | grep -qi 'server-side-encryption'; then
  fail "pre-upgrade object reports encryption; docs say it stays plaintext"
fi

# The same key must still decrypt after a restart, and minio-init must stay re-runnable.
compose restart minio >/dev/null
compose up --exit-code-from minio-init minio-init >/dev/null || fail "minio-init is not re-runnable"
[ "$(mc "mc cat dock/${BUCKET}/new.txt")" = "after-upgrade" ] || fail "encrypted object unreadable after restart"

# The data on disk must not hold the plaintext of the encrypted object.
if docker run --rm -v "${VOLUME}:/data:ro" busybox:1.37 grep -rqa after-upgrade "/data/${BUCKET}"; then
  fail "plaintext of an encrypted object found on the minio volume"
fi
log "live: SSE-S3 on, new objects encrypted and round-trip across a restart, old objects still readable"
