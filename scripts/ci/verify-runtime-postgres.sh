#!/usr/bin/env bash
set -euo pipefail
# Readback only. This exact GitHub service is synthetic; no database discovery,
# configuration mutation, credentials, broad container search or fallback.
[[ $# == 1 && $1 =~ ^[a-f0-9]{64}$ ]]
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
service_id=$1
image=$(docker inspect --format '{{.Config.Image}}' "$service_id")
[[ $image == postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd ]]
ram_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
# A 4GiB upper bound is not a preallocation. Require additional runner RAM for
# two Node shards and PostgreSQL, and record the actual total for diagnosis.
[[ $ram_kib =~ ^[0-9]+$ && $ram_kib -ge 6291456 ]]
printf 'runner_ram_kib=%s runtime_postgres_tmpfs_limit_bytes=4294967296\n' "$ram_kib"
mounts=$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$service_id")
python3 - "$mounts" <<'PY'
import json,sys
mounts=json.loads(sys.argv[1])
assert mounts=={'/var/lib/postgresql':'rw,size=4294967296'}, 'exact bounded PostgreSQL tmpfs required'
PY
filesystem=$(docker exec "$service_id" df -PT /var/lib/postgresql)
printf '%s\n' "$filesystem"
[[ $(printf '%s\n' "$filesystem" | awk 'NR==2 {print $2}') == tmpfs ]]
[[ $(printf '%s\n' "$filesystem" | awk 'NR==2 {print $3}') == 4194304 ]]
settings=$(docker exec "$service_id" psql -U freedom_local -d fp_foundation_ci -v ON_ERROR_STOP=1 -tA -c "SELECT json_build_object('database',current_database(),'data_directory',current_setting('data_directory'),'checkpoint_completion_target',current_setting('checkpoint_completion_target'),'fsync',current_setting('fsync'),'full_page_writes',current_setting('full_page_writes'))")
python3 - "$settings" <<'PY'
import json,sys
s=json.loads(sys.argv[1])
assert s['database']=='fp_foundation_ci'
assert s['data_directory']=='/var/lib/postgresql/18/docker'
assert float(s['checkpoint_completion_target'])==0
assert s['fsync']=='on' and s['full_page_writes']=='on'
print('runtime_postgres_storage_readback=pass checkpoint_completion_target=0 fsync=on full_page_writes=on')
PY
