#!/usr/bin/env bash
set -euo pipefail
# Readback only. This exact GitHub service is synthetic; no database discovery,
# configuration mutation, credentials, broad container search or fallback.
[[ $# == 1 && $1 =~ ^[a-f0-9]{64}$ ]]
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
service_id=$1
image=$(docker inspect --format '{{.Config.Image}}' "$service_id")
[[ $image == mirror.gcr.io/library/postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd ]]
ram_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
# PostgreSQL has a 4 GiB memory ceiling; its data is on a disposable disk volume.
# Require additional runner RAM for Node and record the actual total.
[[ $ram_kib =~ ^[0-9]+$ && $ram_kib -ge 6291456 ]]
printf 'runner_ram_kib=%s runtime_postgres_memory_limit_bytes=4294967296\n' "$ram_kib"
storage=$(docker inspect --format '{{json .}}' "$service_id")
python3 - "$storage" <<'PY'
import json,sys
s=json.loads(sys.argv[1])
assert not s['HostConfig'].get('Tmpfs'), 'PostgreSQL test data must not use tmpfs'
assert s['HostConfig']['Memory']==4294967296, 'bounded PostgreSQL memory required'
mounts=s['Mounts']
assert len(mounts)==1 and mounts[0]['Type']=='volume' and mounts[0]['Destination']=='/var/lib/postgresql' and mounts[0]['RW'], 'owned writable PostgreSQL disk volume required'
PY
filesystem=$(docker exec "$service_id" df -PT /var/lib/postgresql)
printf '%s\n' "$filesystem"
filesystem_type=$(printf '%s\n' "$filesystem" | awk 'NR==2 && NF==7 {print $2}')
[[ -n $filesystem_type && $filesystem_type != tmpfs && $filesystem_type != ramfs ]]
settings=$(docker exec "$service_id" psql -U freedom_local -d fp_foundation_ci -v ON_ERROR_STOP=1 -tA -c "SELECT json_build_object('database',current_database(),'data_directory',current_setting('data_directory'),'checkpoint_completion_target',current_setting('checkpoint_completion_target'),'max_locks_per_transaction',current_setting('max_locks_per_transaction'),'dynamic_shared_memory_type',current_setting('dynamic_shared_memory_type'),'fsync',current_setting('fsync'),'full_page_writes',current_setting('full_page_writes'))")
python3 - "$settings" <<'PY'
import json,sys
s=json.loads(sys.argv[1])
assert s['database']=='fp_foundation_ci'
assert s['data_directory']=='/var/lib/postgresql/18/docker'
assert float(s['checkpoint_completion_target'])==0
assert int(s['max_locks_per_transaction'])==256
assert s['dynamic_shared_memory_type']=='mmap'
assert s['fsync']=='on' and s['full_page_writes']=='on'
print('runtime_postgres_storage_readback=pass storage=disk checkpoint_completion_target=0 max_locks_per_transaction=256 dynamic_shared_memory_type=mmap fsync=on full_page_writes=on')
PY
