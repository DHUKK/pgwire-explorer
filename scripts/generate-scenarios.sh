#!/usr/bin/env bash
#
# Regenerates the shipped examples in site/public/scenarios/ from real
# Postgres traffic. Every example the site ships is produced by this script.
# None are hand-written, so what the UI shows is what Postgres actually did.
#
# It needs:
#   - Go (to build pgwire-capture and pgwire-demo)
#   - Docker, running (to run the Postgres server)
#   - psql on PATH (the real client that drives four of the examples)
#
# The auth examples need a server configured for scram-sha-256 and then
# md5, which is invasive, so the script runs a throwaway Postgres container on
# its own port and removes it at the end. It does NOT touch any Postgres you
# already run, in Docker or otherwise.
#
# Usage: scripts/generate-scenarios.sh [name ...]
# With no arguments it regenerates every example. Named examples regenerate only
# those, leaving the other files on disk untouched, which matters because every
# recording is slightly different: fresh SCRAM salts, a new backend PID, a
# different packet count. Regenerating all thirteen to change one moves the packet
# IDs the highlight ranges in site/src/lib/scenarios.ts are written in.
#
# Override the Postgres image with PG_IMAGE=postgres:17 scripts/generate-scenarios.sh
#
# The protocol-32-downgrade scenario asks PG_IMAGE (postgres:16 by default) for
# protocol 3.2 (added in PostgreSQL 18), which it does not speak, and adds an
# unrecognized _pq_.-prefixed option. Both NegotiateProtocolVersion triggers
# fire at once: the server downgrades the connection to 3.0 and reports the
# unrecognized option in the same message.

set -euo pipefail

cd "$(dirname "$0")/.."
OUT=site/public/scenarios
mkdir -p "$OUT"

ALL=(scram-auth trust-auth simple-query extended-query copy error-response
  notify cancel-request protocol-32-downgrade replication-physical
  replication-logical cleartext-auth md5-auth)
WANTED=("$@")
# Expanded only when non-empty: under set -u, bash 3.2 (what macOS ships) treats
# "${WANTED[@]}" on an empty array as an unbound variable.
if [[ ${#WANTED[@]} -gt 0 ]]; then
  for want in "${WANTED[@]}"; do
    # A typo would otherwise be a silent no-op that looks like a successful run.
    [[ " ${ALL[*]} " == *" $want "* ]] || {
      echo "error: unknown example '$want'. Known: ${ALL[*]}" >&2
      exit 1
    }
  done
fi

PG_IMAGE="${PG_IMAGE:-postgres:16}"

command -v docker >/dev/null || { echo "error: docker not found" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "error: docker daemon is not running" >&2; exit 1; }
command -v psql >/dev/null || { echo "error: psql not found. Install a Postgres client" >&2; exit 1; }

WORK="$(mktemp -d)"
CONTAINER="pgwire-scenario-gen-$$"
PGPORT=55432          # throwaway container, deliberately not 5432
PROXY_PORT=5434       # deliberately not 5433, in case one is already running
PASSWORD='wire_demo_password'

BUILD="$WORK/bin"
mkdir -p "$BUILD"
go build -o "$BUILD/pgwire-capture" ./cmd/pgwire-capture
go build -o "$BUILD/pgwire-demo" ./cmd/pgwire-demo

PROXY_PID=""
cleanup() {
  [[ -n "$PROXY_PID" ]] && kill -INT "$PROXY_PID" 2>/dev/null || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- throwaway container ----------------------------------------------------
# A connection through the published port arrives at the container from Docker's
# bridge gateway, not literally as 127.0.0.1, so it is matched by the "host all
# all all" line rather than by any loopback line. set_auth below owns that line,
# which is why every example's auth method is decided here and not by the image.
# Pulls the image on first run, which can take a minute.
echo "starting $PG_IMAGE"
docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  -p "127.0.0.1:$PGPORT:5432" \
  "$PG_IMAGE" >/dev/null

# Up to two minutes: the image runs initdb on its first start, which is slow
# on a loaded machine, and a false timeout here wastes a whole regeneration.
for _ in $(seq 1 240); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || {
  echo "error: container did not become ready. Logs:" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

# set_auth <method> rewrites pg_hba.conf so every connection through the proxy
# authenticates with <method>, and reloads. No restart: pg_hba.conf takes effect
# on a reload, which is why the auth method can be changed between captures.
#
# The whole file is rewritten rather than sed'ed over the image's own, so what
# authenticates a connection is stated here instead of depending on which of the
# image's lines happens to match. Two lines are needed, not one: a connection
# carrying replication=true/database is matched against the special "replication"
# pseudo-database and not against "all", so the replication examples would
# otherwise fall through.
#
# The local line stays trust throughout, because this script's own admin work
# runs as `docker exec psql` over the unix socket and must keep working whatever
# the host method is set to.
set_auth() {
  local method="$1"
  echo "  auth method: $method"
  docker exec -i "$CONTAINER" bash -c 'cat > /var/lib/postgresql/data/pg_hba.conf' <<HBA
# Written by scripts/generate-scenarios.sh. Throwaway container, never a real one.
local   all         all            trust
host    all         all  all       $method
host    replication all  all       $method
HBA
  docker exec "$CONTAINER" psql -U postgres -c "SELECT pg_reload_conf();" >/dev/null
}

# wanted <name> is true when this run should record <name>. No arguments means
# every example.
wanted() {
  [[ ${#WANTED[@]} -eq 0 ]] && return 0
  local name="$1" w
  for w in "${WANTED[@]}"; do
    [[ "$w" == "$name" ]] && return 0
  done
  return 1
}

# capture <output-name> <command...>
# Starts the proxy, runs the command against it, stops the proxy so the capture
# is flushed. Proxies to the throwaway container for
# the duration of that one call.
# --expect-client-failure allows a nonzero client exit, for an example whose
# subject IS a failure. psql exits nonzero when its last statement errored, even
# under ON_ERROR_STOP=0, so a capture ending on a deliberate error would
# otherwise abort the whole run. Opted into per capture rather than ignored
# globally, so a client that breaks for a reason nobody intended still stops the
# script instead of silently writing half an example.
capture() {
  local expect_client_failure=0
  if [[ "$1" == "--expect-client-failure" ]]; then
    expect_client_failure=1
    shift
  fi
  local name="$1"; shift
  wanted "$name" || { echo "  skipping $name"; return 0; }
  echo "  recording $name"
  "$BUILD/pgwire-capture" \
    --listen "127.0.0.1:$PROXY_PORT" \
    --upstream "127.0.0.1:$PGPORT" \
    --out "$OUT/$name.json" >"$WORK/proxy-$name.log" 2>&1 &
  PROXY_PID=$!
  sleep 1

  "$@" >"$WORK/client-$name.log" 2>&1 || {
    if [[ $expect_client_failure -eq 0 ]]; then
      echo "error: client failed for $name. Output:" >&2
      cat "$WORK/client-$name.log" >&2
      exit 1
    fi
  }

  sleep 0.5
  kill -INT "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
  PROXY_PID=""
}

psql_at_proxy() {
  PGPASSWORD="$PASSWORD" psql \
    -h 127.0.0.1 -p "$PROXY_PORT" -U postgres -d postgres \
    -v ON_ERROR_STOP=0 --quiet "$@"
}

# sslmode=disable, deliberately: with sslmode=prefer, pgx opens a connection,
# gets the proxy's SSL denial, throws that connection away and reconnects.
# That leaves a pointless 2-packet session at the front of the example. SSL
# negotiation is still on show in the psql-driven examples, which do use
# prefer.
demo_at_proxy() {
  "$BUILD/pgwire-demo" \
    --dsn "postgres://postgres:$PASSWORD@127.0.0.1:$PROXY_PORT/postgres?sslmode=disable" \
    --setup-dsn "postgres://postgres:$PASSWORD@127.0.0.1:$PGPORT/postgres?sslmode=disable" \
    --mode "$1"
}

# demo_at_proxy_32 asks pgx for protocol 3.2 (max_protocol_version, added in
# pgx v5.10.0 to match libpq 18) and adds an unrecognized _pq_.-prefixed
# startup parameter. It is used against the main container (PG_IMAGE,
# postgres:16 by default), which does not speak 3.2, so this is a genuine
# minor-version downgrade: the server's NegotiateProtocolVersion reply
# reports Newest Minor Protocol 196608 (3.0), the version it actually uses
# for the rest of the session, and lists the unrecognized option in the same
# message. Both triggers documented for NegotiateProtocolVersion (unsupported
# minor version, unsupported _pq_. option) fire from this one request.
demo_at_proxy_32() {
  "$BUILD/pgwire-demo" \
    --dsn "postgres://postgres:$PASSWORD@127.0.0.1:$PROXY_PORT/postgres?sslmode=disable&max_protocol_version=3.2&_pq_.wire_demo_unsupported_option=1" \
    --mode "$1"
}

# cancel_client runs a slow query and interrupts it, which is the only reliable
# way to produce a real CancelRequest: psql catches SIGINT and opens a SECOND
# connection to cancel, quoting the backend PID and secret key from
# BackendKeyData. pgx does not do this. On context cancellation it drops the
# connection, so the capture would show a query and then nothing.
#
# psql is invoked directly rather than through psql_at_proxy: backgrounding a
# shell FUNCTION makes $! the subshell's pid, so the SIGINT would go to the
# subshell and psql would never see it, producing a capture with a query and no
# cancellation in it.
cancel_client() {
  PGPASSWORD="$PASSWORD" psql \
    -h 127.0.0.1 -p "$PROXY_PORT" -U postgres -d postgres \
    --quiet -c "SELECT pg_sleep(30);" &
  local psql_pid=$!
  sleep 1.5
  kill -INT "$psql_pid" 2>/dev/null || true
  wait "$psql_pid" 2>/dev/null || true
  sleep 0.5
}

echo "generating examples into $OUT"

# The auth method is set per group below and the groups are ordered by it, so
# each switch happens once. Only the three authentication examples are recorded
# under a method of their own. Everything else is recorded under trust, which
# reduces its startup preamble to StartupMessage and AuthenticationOk: a capture
# about COPY or replication should not open with five messages of SASL, and the
# highlight ranges in site/src/lib/scenarios.ts exist to mark what differs
# between captures rather than what they all share.

# --- 1. SCRAM-SHA-256 authentication ---------------------------------------
set_auth scram-sha-256
capture scram-auth psql_at_proxy -c "SELECT 'authenticated' AS status;"

# --- 2. trust: no authentication exchange at all ---------------------------
# AuthenticationOk straight after StartupMessage, with nothing in between. This
# is also the preamble every example below it now has, which is the point: it is
# the shortest handshake the protocol allows.
set_auth trust
capture trust-auth psql_at_proxy -c "SELECT 'authenticated' AS status;"

# --- 3. simple query protocol ----------------------------------------------
# Two queries and no more, which is what the example claims to be: one full
# successful cycle and one failed one.
#
# The failing statement is deliberate. In the simple protocol an ErrorResponse
# is followed straight away by ReadyForQuery, so the connection is usable again
# immediately. Compare with the error-response example, where the extended
# protocol makes the server discard everything until Sync.
#
# The rows come from a VALUES list rather than a temp table so that one query
# produces them, with no CREATE and INSERT cycles in front of it that the
# example does not exist to show. The NULL is worth keeping: it is the only NULL
# DataRow column in any capture, and NULL on the wire is a length of -1 with no
# value bytes at all, which is a different thing from a value of length zero.
capture --expect-client-failure simple-query psql_at_proxy \
  -c "SELECT id, label FROM (VALUES (1, 'first'), (2, NULL)) AS t (id, label) ORDER BY id;" \
  -c "SELECT * FROM no_such_table;"

# --- 4. extended query protocol --------------------------------------------
capture extended-query demo_at_proxy extended

# --- 5. COPY, both directions -----------------------------------------------
# Copy-in and copy-out are two distinct sub-protocols, in the protocol docs'
# own words, so the example shows both. The formats differ on purpose: pgx's
# CopyFrom sends binary, the COPY TO STDOUT comes back as text.
capture copy demo_at_proxy copy

# --- 6. errors --------------------------------------------------------------
capture error-response demo_at_proxy error

# --- 7. LISTEN/NOTIFY: an unprompted server message -------------------------
capture notify demo_at_proxy notify

# --- 8. query cancellation (two connections) --------------------------------
capture cancel-request cancel_client

# --- 9. protocol version downgrade + unsupported option (both triggers) ----
# Recorded under trust, like everything else in this group and deliberately
# before the switch to cleartext and md5 below: a scenario about version
# negotiation showing a deprecated authentication method would be a
# distraction from the NegotiateProtocolVersion reply it exists to show.
capture protocol-32-downgrade demo_at_proxy_32 protocol32

# --- 10 & 11. streaming replication -----------------------------------------
# Physical replication only needs the default wal_level (replica), but logical
# replication needs wal_level=logical, which is NOT the image's default and,
# unlike the auth settings above, only takes effect after a restart, not a
# reload. Restarting now, before either replication capture, keeps this
# script's one restart in one place instead of bracketing just the logical
# capture.
if wanted replication-physical || wanted replication-logical; then
echo "  switching to wal_level=logical (needs a restart)"
docker exec "$CONTAINER" psql -U postgres -c "ALTER SYSTEM SET wal_level='logical';" >/dev/null
docker restart "$CONTAINER" >/dev/null
# Up to two minutes: the image runs initdb on its first start, which is slow
# on a loaded machine, and a false timeout here wastes a whole regeneration.
for _ in $(seq 1 240); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || {
  echo "error: container did not come back up after the wal_level restart. Logs:" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}
fi

capture replication-physical demo_at_proxy replication-physical
capture replication-logical demo_at_proxy replication-logical

# --- 12. cleartext password authentication ----------------------------------
# The password crosses the wire in the PasswordMessage with no hashing at all,
# which is the entire argument for the two methods above. Safe to commit only
# because PASSWORD is this script's throwaway, is already in plaintext a few
# lines up, and the container it belongs to is removed on exit. Never record
# this one against a server whose password you care about.
#
# No ALTER USER needed: the server compares the cleartext it receives against
# whatever it already has stored, so the secret can stay SCRAM-encrypted.
set_auth password
capture cleartext-auth psql_at_proxy -c "SELECT 'authenticated' AS status;"

# --- 13. MD5 authentication (legacy) ----------------------------------------
# Goes last because it is the one method that needs the stored secret changed,
# not just pg_hba: password_encryption governs how ALTER USER hashes it, and md5
# authentication cannot verify against a SCRAM verifier. Both take effect on a
# reload, so the container is never restarted for this.
docker exec "$CONTAINER" psql -U postgres -c "ALTER SYSTEM SET password_encryption='md5';" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "SELECT pg_reload_conf();" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "ALTER USER postgres PASSWORD '$PASSWORD';" >/dev/null
set_auth md5
capture md5-auth psql_at_proxy -c "SELECT 'authenticated' AS status;"

echo
echo "done. examples written to $OUT:"
ls -1 "$OUT"/*.json | sed 's/^/  /'
echo
echo "Verify them with: go test ./internal/capture -run TestScenarios"
