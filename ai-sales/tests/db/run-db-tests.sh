#!/usr/bin/env bash
# Spins up a throwaway local Postgres, loads a Supabase stand-in + a replica of the existing schema,
# applies every AI Sales migration, then runs the SQL tests. Never touches a real database.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../supabase/migrations"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/postgres" ] || { echo "SKIP: no local PostgreSQL server binaries found"; exit 0; }

WORK="$(mktemp -d)"; chmod 755 "$WORK"
RUNAS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; RUNAS=(runuser -u postgres --); fi
PORT="${PGTEST_PORT:-54329}"
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database t" >/dev/null
"${PSQL[@]}" -d t -f "$HERE/00-supabase-stub.sql" >/dev/null
"${PSQL[@]}" -d t -f "$HERE/01-existing-schema.sql" >/dev/null
for f in "$MIG"/*.sql; do echo "apply $(basename "$f")"; "${PSQL[@]}" -d t -f "$f" >/dev/null; done
"${PSQL[@]}" -d t -f "$HERE/10-tests.sql"
