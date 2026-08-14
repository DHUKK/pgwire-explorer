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

## Currently unsupported message types

The documentation for PostgreSQL 7.4 through 18 lists 55 messages between them, and 51 are
decoded and annotated field by field. All of it is protocol version 3.0 and 3.2, both of which
this tool reads: 3.2 changed the layout of `BackendKeyData` and `CancelRequest` rather than the
set of messages. `TestProtocolCoverage` in
`internal/pgproto/coverage_test.go` checks that claim in both directions, so this list cannot
go stale quietly.

| Message | Code | Why not |
| --- | --- | --- |
| `AuthenticationKerberosV4` | 1 | Gone from the docs after 8.0, when GSSAPI replaced it |
| `AuthenticationKerberosV5` | 2 | The protocol docs say of it: "This is no longer supported." Replaced by GSSAPI, which is decoded |
| `AuthenticationCryptPassword` | 4 | Gone from the docs after 8.3. It predates md5, let alone SCRAM |
| `AuthenticationSCMCredential` | 6 | Documented up to 15 and gone from 16. Only pre-9.1 servers sent it, and its credential travelled as socket ancillary data rather than in the byte stream, so there was never anything for a capture to show |

Every release in that range rather than only the newest, because a capture can come from
whichever server a visitor is running. 7.4 is where protocol major version 3 arrived, so
that range is the whole life of it.

All four are authentication requests Postgres stopped sending long ago, which is why no
recording here contains one. Together they explain the gaps at authentication codes 1, 4 and 6.

An unsupported message is not a broken one. Framing does not depend on decoding, because
every message carries its own length, so an unrecognised message is one whose bytes are
located exactly and merely not explained. It renders as `Unknown` with its type identifier,
its length, and its payload under a field naming the decode error.

## Tests

```sh
go test ./...                            # protocol decoding, invariants, golden replay
go test ./internal/pgproto -fuzz FuzzDecode -fuzztime=30s   # Decode must never panic
cd site && npm test                      # parser, state engine, scenario manifest
```
