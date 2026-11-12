#!/bin/bash
set -euo pipefail
cd /usr/src/app
export CONFIG_DIR="${CONFIG_DIR:-/opt/config}"
export CONFIG="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
test -w "$CONFIG_DIR" || { echo 'Config directory must be writable by UID 1001'; exit 1; }
test -s build/public/templates/header.js || { echo 'Image assets missing: rebuild image; do not mount build/'; exit 1; }
if [[ -n "${NODEBB_ADDITIONAL_PLUGINS:-}" || "${START_BUILD:-false}" == true || "${FORCE_BUILD_BEFORE_START:-false}" == true ]]; then
  echo 'Offline image: install plugins and build assets locally, then release a new image.'
  exit 1
fi
if [[ "${SETUP:-}" == 1 ]]; then
  exec node nodebb setup --skip-build --config="$CONFIG"
fi
if [[ ! -f "$CONFIG" ]]; then
  echo 'Run the one-off SETUP=1 initialization before starting this service.'
  exit 1
fi
# Only database migrations; no dependency installation or asset build.
node nodebb upgrade --schema --config="$CONFIG"
exec node loader.js --config="$CONFIG" --no-silent --no-daemon
