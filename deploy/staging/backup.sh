#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/freedom-staging/backups"
mkdir -p "$backup_dir"
backup_file="$backup_dir/freedom-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
partial_file="$backup_file.partial"
database_name="${FREEDOM_DATABASE_NAME:-freedom_local}"
[[ "$database_name" =~ ^[a-z][a-z0-9_]*$ ]] || { printf 'Invalid database name\n' >&2; exit 1; }
trap 'rm -f "$partial_file"' EXIT
docker compose -f compose.yaml -f deploy/staging/compose.override.yaml exec -T postgres \
  pg_dump -U freedom_local -d "$database_name" --format=custom > "$partial_file"
test -s "$partial_file"
mv "$partial_file" "$backup_file"
printf 'Database backup saved: %s\n' "$backup_file"
