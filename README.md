# pgwire-explorer

The Postgres frontend/backend protocol (v3) is well documented but hard to see in action.
This tool records a real session between a client and a real Postgres server, decodes every
message, and maps every byte of every packet to the field that produced it. The result is a
static site: a message list on one side, a live hex dump on the other, with nothing
unexplained.

## Recording a capture

```sh
go run ./cmd/pgwire-capture --out cap.json   # listens on 5433, forwards to 5432
psql -h localhost -p 5433                    # then Ctrl+C the proxy to write the file
```

Both ports are flags (`--listen`, `--upstream`) if your Postgres is somewhere else. The proxy
relays every byte unmodified and answers `SSLRequest` and `GSSENCRequest` itself with `N`, so
the session stays plaintext and inspectable.

## Running the explorer

```sh
cd site && npm install && npm run dev     # http://localhost:5173
```

A static site with no backend. Nothing is uploaded. Drop in your own capture, or start from
one of the bundled scenarios.

Two panes: the message list and the selected message, with a status bar underneath showing
`TLS`, `AUTH` and `TX`. Pressing <kbd>s</kbd> expands those into a drawer with an explanation
of each, plus the session details and server settings.

Step with <kbd>j</kbd>/<kbd>k</kbd> or the arrows, <kbd>Home</kbd> and <kbd>End</kbd> to jump.
Hovering a field highlights its bytes in the hex dump. Clicking a byte selects the field that
explains it. The theme follows the system by default and can be pinned to light or dark. A
scenario lives in the URL hash, so it can be linked to and the browser's back button works.

## Scenarios

Every scenario is a real recording, produced by `scripts/generate-scenarios.sh`. None are
hand-written. The script runs a throwaway Postgres container on its own port and removes it
afterwards, so your own Postgres is never touched. Examples include SCRAM and MD5
authentication, the simple and extended query protocols, COPY, query cancellation, and
physical and logical replication.

```sh
scripts/generate-scenarios.sh            # needs Docker running and psql on PATH
go test ./internal/capture -run TestScenarios
```

## Tests

```sh
go test ./...                            # protocol decoding, invariants, golden replay
go test ./internal/pgproto -fuzz FuzzDecode -fuzztime=30s   # Decode must never panic
cd site && npm test                      # parser, state engine, scenario manifest
```
