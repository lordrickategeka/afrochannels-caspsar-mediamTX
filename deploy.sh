#!/usr/bin/env bash
#
# Run ON THE INGEST VM to apply whatever is currently on the main branch:
#
#   ~/afrochannels-caspsar-mediamTX/deploy.sh
#
# Everything in the deploy directory is overwritten from git EXCEPT .env, which
# holds this machine's secrets and its feed URL and is never touched.

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/dewatch}"
PLACEHOLDER='CHANGE_ME_MATCH_MEDIAMTX_PUBLISH_PASSWORD'

say() { printf '\n== %s\n' "$1"; }

# The docker group membership only applies after a re-login, so fall back to
# sudo rather than failing on a freshly provisioned machine.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

say "Pulling latest from git"
git -C "$REPO_DIR" pull --ff-only

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "ERROR: $DEPLOY_DIR/.env is missing."
  echo "Copy .env.vm.example there as .env, fill it in, then re-run."
  exit 1
fi

# shellcheck disable=SC1091
set -a; . "$DEPLOY_DIR/.env"; set +a
: "${MEDIAMTX_PUBLISH_PASSWORD:?must be set in $DEPLOY_DIR/.env}"

say "Copying config into $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/logs/caddy"
cp "$REPO_DIR/docker-compose.cloud.yml" "$DEPLOY_DIR/docker-compose.yml"
cp "$REPO_DIR/Caddyfile"                "$DEPLOY_DIR/Caddyfile"
cp "$REPO_DIR/mediamtx.cloud.yml"       "$DEPLOY_DIR/mediamtx.yml"

# The committed mediamtx.yml carries a placeholder so it is safe to push. The
# real password exists only on this machine, in .env and in the deployed copy.
# MediaMTX reads the file rather than the environment - an MTX_* override does
# not reach it - so this substitution is the only mechanism that actually works.
say "Substituting publish password"
sed -i "s|$PLACEHOLDER|$MEDIAMTX_PUBLISH_PASSWORD|" "$DEPLOY_DIR/mediamtx.yml"
chmod 600 "$DEPLOY_DIR/mediamtx.yml"
if grep -q "$PLACEHOLDER" "$DEPLOY_DIR/mediamtx.yml"; then
  echo "ERROR: placeholder still present after substitution"; exit 1
fi

# Started conditionally: Caddy fails its ACME challenge without a domain, and
# ffmpeg restart-loops against an empty input URL.
SERVICES=(mediamtx)
if [ -n "${STREAM_DOMAIN:-}" ]; then SERVICES+=(caddy)
else echo "  STREAM_DOMAIN empty - skipping caddy (LAN access on :8888 only)"; fi
if [ -n "${MULTICAST_SOURCE:-}" ]; then
  : "${MULTICAST_PROGRAM:?set it in .env - one multicast group carries several TV services}"
  : "${MULTICAST_PATH:?set it in .env - the MediaMTX path name to publish to}"
  SERVICES+=(ffmpeg-ingest)
else echo "  MULTICAST_SOURCE empty - skipping ffmpeg-ingest (no static feed)"; fi

say "Starting: ${SERVICES[*]}"
cd "$DEPLOY_DIR"
$DOCKER compose up -d --remove-orphans "${SERVICES[@]}"

say "Status"
$DOCKER compose ps
