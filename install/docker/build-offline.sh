#!/bin/bash
set -euo pipefail
export PATH="$(echo /usr/lib/postgresql/*/bin):$PATH"
export INITIAL_APPEARANCE_SNAPSHOT=/usr/src/app/install/docker/appearance.snapshot.json
initdb -D /tmp/nodebb-build-db -A trust --no-locale >/dev/null
trap 'pg_ctl -D /tmp/nodebb-build-db -m immediate stop >/dev/null 2>&1 || true' EXIT
pg_ctl -D /tmp/nodebb-build-db -l /tmp/nodebb-build-db.log -o '-h 127.0.0.1 -p 55432 -k /tmp' start
createdb -h 127.0.0.1 -p 55432 nodebb_build
node nodebb setup '{"url":"http://aixsilicon.developers.hisilicon.com:9203","database":"postgres","postgres:host":"127.0.0.1","postgres:port":55432,"postgres:database":"nodebb_build","postgres:username":"nodebb","postgres:password":"","postgres:ssl":false,"admin:username":"build-admin","admin:password":"BuildOnly!8b1c7d2e9f","admin:password:confirm":"BuildOnly!8b1c7d2e9f","admin:email":"build@example.invalid","submitPluginUsage":"no"}' --skip-build
node nodebb build --series
test -s build/public/templates/header.tpl
test -s build/public/templates/header.js
test -s build/public/nodebb.min.js
test -s build/public/admin.min.js
test -s build/public/client.css
pg_ctl -D /tmp/nodebb-build-db -m immediate stop
trap - EXIT
rm -rf /tmp/nodebb-build-db /tmp/nodebb-build-db.log config.json public/uploads logs
mkdir -p public/uploads logs
