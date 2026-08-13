// Command pgwire-demo drives a Postgres connection through specific parts of
// the wire protocol, to regenerate the teaching scenarios in
// site/public/scenarios from real traffic.
//
// It is only a fixture generator. Point it at pgwire-capture, not at a real
// database you care about: the copy and error modes create temp tables and
// deliberately fail statements.
//
// See scripts/generate-scenarios.sh for how the scenarios are actually built.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
)

func main() {
	dsn := flag.String("dsn", "postgres://postgres@127.0.0.1:5433/postgres?sslmode=prefer",
		"connection string, pointed at the capturing proxy")
	setupDSN := flag.String("setup-dsn", "postgres://postgres@127.0.0.1:5432/postgres?sslmode=prefer",
		"connection string for scaffolding that must not be recorded, pointed directly at Postgres, "+
			"bypassing the proxy. Only the replication modes use this.")
	mode := flag.String("mode", "extended",
		"what to exercise: extended, copy, cancel, error, notify, protocol32, replication-physical, replication-logical")
	flag.Parse()

	ctx := context.Background()
	if err := run(ctx, *dsn, *setupDSN, *mode); err != nil {
		log.Fatalf("%s: %v", *mode, err)
	}
	fmt.Fprintf(os.Stderr, "%s: ok\n", *mode)
}

func run(ctx context.Context, dsn, setupDSN, mode string) error {
	// The replication modes drive the wire protocol by hand, because a
	// replication connection needs the startup parameter replication=true or
	// replication=database, which pgx's high-level Conn has no clean way to
	// send. They bypass pgx.Conn entirely, so they are dispatched before it is
	// ever constructed.
	switch mode {
	case "replication-physical":
		return replicationPhysical(ctx, dsn, setupDSN)
	case "replication-logical":
		return replicationLogical(ctx, dsn, setupDSN)
	}

	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("parse dsn: %w", err)
	}

	// QueryExecModeCacheStatement is what produces the full extended-query
	// exchange (Parse/Bind/Describe/Execute/Sync) rather than a simple Query.
	cfg.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement

	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)

	switch mode {
	case "extended":
		return extended(ctx, conn)
	case "copy":
		return copyFlow(ctx, conn)
	case "cancel":
		return cancel(ctx, conn)
	case "error":
		return errorFlow(ctx, conn)
	case "notify":
		return notify(ctx, conn)
	case "protocol32":
		return protocol32(ctx, conn)
	}
	return fmt.Errorf("unknown mode %q", mode)
}

// extended runs a parameterized query twice. The first pass shows
// Parse/Describe/Bind/Execute in full. The second reuses the cached prepared
// statement and skips straight to Bind/Execute, which is the whole point of the
// extended protocol and only visible by comparing the two.
func extended(ctx context.Context, conn *pgx.Conn) error {
	const sql = `SELECT $1::int AS id, $2::text AS label, $3::bool AS flag`

	for pass := 1; pass <= 2; pass++ {
		rows, err := conn.Query(ctx, sql, 42*pass, nil, pass == 1)
		if err != nil {
			return fmt.Errorf("pass %d: %w", pass, err)
		}
		for rows.Next() {
			var id int
			var label *string // NULL on the wire: length -1, no bytes
			var flag bool
			if err := rows.Scan(&id, &label, &flag); err != nil {
				rows.Close()
				return fmt.Errorf("pass %d scan: %w", pass, err)
			}
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("pass %d rows: %w", pass, err)
		}
	}
	return nil
}

// copyFlow runs a copy in both directions, which is two sub-protocols and not
// one. The protocol docs put it plainly: "Copy-in and copy-out operations each
// switch the connection into a distinct sub-protocol, which lasts until the
// operation is completed." Copy-in is entered by COPY FROM STDIN and answered
// with CopyInResponse, copy-out by COPY TO STDOUT and answered with
// CopyOutResponse. When either finishes, the connection reverts to whichever
// command-processing mode it was in before.
//
// The two directions deliberately use different formats. pgx's CopyFrom sends
// binary, so the copy-in payload is length-prefixed and opaque. The copy-out
// asks for the default text format, so its CopyData payloads are the rows as
// readable tab-separated lines. Both are the same message type carrying very
// different bytes, and the format is declared in the CopyInResponse and
// CopyOutResponse that open each direction.
func copyFlow(ctx context.Context, conn *pgx.Conn) error {
	if _, err := conn.Exec(ctx, `CREATE TEMP TABLE copy_demo (id int, label text)`); err != nil {
		return fmt.Errorf("create temp table: %w", err)
	}

	rows := [][]any{{1, "first"}, {2, "second"}, {3, nil}}
	n, err := conn.CopyFrom(ctx, pgx.Identifier{"copy_demo"}, []string{"id", "label"}, pgx.CopyFromRows(rows))
	if err != nil {
		return fmt.Errorf("copy from: %w", err)
	}
	if n != int64(len(rows)) {
		return fmt.Errorf("copied %d rows, want %d", n, len(rows))
	}

	// Straight back out again, which is the other half of the sub-protocol and
	// replaces what used to be an extended-protocol SELECT count(*). A read-back
	// through Parse and Bind showed nothing this example exists to show.
	var out bytes.Buffer
	tag, err := conn.PgConn().CopyTo(ctx, &out, `COPY copy_demo TO STDOUT`)
	if err != nil {
		return fmt.Errorf("copy to: %w", err)
	}
	if got := tag.String(); got != fmt.Sprintf("COPY %d", len(rows)) {
		return fmt.Errorf("copy out tag = %q, want COPY %d", got, len(rows))
	}
	if lines := strings.Count(strings.TrimSuffix(out.String(), "\n"), "\n") + 1; lines != len(rows) {
		return fmt.Errorf("copy out returned %d lines, want %d", lines, len(rows))
	}
	return nil
}

// cancel starts a slow query and cancels it. The CancelRequest travels on a
// SECOND connection, because the first is busy, quoting the backend PID and
// secret key from BackendKeyData. That is why the capture contains two sessions.
func cancel(ctx context.Context, conn *pgx.Conn) error {
	queryCtx, stop := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer stop()

	_, err := conn.Exec(queryCtx, `SELECT pg_sleep(30)`)
	if err == nil {
		return errors.New("expected the query to be cancelled, but it completed")
	}

	// The server reports the cancellation as ERROR 57014 query_canceled. Any
	// other failure means we captured the wrong thing.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "57014" {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return fmt.Errorf("unexpected error: %w", err)
}

// errorFlow shows ErrorResponse once per protocol, because the two protocols
// recover from a failure differently.
//
// First the extended protocol, where a failed statement poisons the batch:
// everything between the error and the next Sync is discarded by the server,
// which is why the Describe sent here never gets a reply of its own.
//
// Then the simple protocol inside an explicit transaction, which is where an
// error has a lasting effect. Once the INSERT fails the transaction is aborted:
// ReadyForQuery reports Failed, the next statement is rejected with 25P02
// without being run, and only ROLLBACK gets back to Idle.
func errorFlow(ctx context.Context, conn *pgx.Conn) error {
	_, err := conn.Query(ctx, `SELECT * FROM table_that_does_not_exist`)
	if err == nil {
		return errors.New("expected the query to fail")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42P01" {
		return fmt.Errorf("expected undefined_table (42P01), got: %w", err)
	}

	// Seeded before BEGIN, so the ROLLBACK below does not take away the row the
	// unique violation has to collide with.
	if _, err := conn.Exec(ctx, `CREATE TEMP TABLE uniq_demo (id int PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create temp table: %w", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO uniq_demo VALUES (1)`); err != nil {
		return fmt.Errorf("seed insert: %w", err)
	}

	if _, err := conn.Exec(ctx, `BEGIN`); err != nil {
		return fmt.Errorf("begin: %w", err)
	}

	// A richer ErrorResponse than the first: a detail field, a schema, a table
	// and the constraint name.
	_, err = conn.Exec(ctx, `INSERT INTO uniq_demo VALUES (1)`)
	if err == nil {
		return errors.New("expected a unique violation")
	}
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return fmt.Errorf("expected unique_violation (23505), got: %w", err)
	}

	// Never run. The transaction is already aborted, so the server rejects this
	// on arrival rather than executing it.
	_, err = conn.Exec(ctx, `SELECT 1`)
	if err == nil {
		return errors.New("expected the aborted transaction to reject the next statement")
	}
	if !errors.As(err, &pgErr) || pgErr.Code != "25P02" {
		return fmt.Errorf("expected in_failed_sql_transaction (25P02), got: %w", err)
	}

	if _, err := conn.Exec(ctx, `ROLLBACK`); err != nil {
		return fmt.Errorf("rollback: %w", err)
	}
	return nil
}

// notify exercises NotificationResponse, the only message a server sends
// unprompted. It arrives with no request of its own in flight.
func notify(ctx context.Context, conn *pgx.Conn) error {
	if _, err := conn.Exec(ctx, `LISTEN wire_demo`); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	if _, err := conn.Exec(ctx, `NOTIFY wire_demo, 'hello from the wire'`); err != nil {
		return fmt.Errorf("notify: %w", err)
	}

	waitCtx, stop := context.WithTimeout(ctx, 3*time.Second)
	defer stop()
	n, err := conn.WaitForNotification(waitCtx)
	if err != nil {
		return fmt.Errorf("wait for notification: %w", err)
	}
	if !strings.Contains(n.Payload, "hello") {
		return fmt.Errorf("unexpected payload %q", n.Payload)
	}
	return nil
}

// protocol32 backs two scenarios that both just connect and disconnect,
// differing only in the dsn scripts/generate-scenarios.sh gives them:
//
//   - against a server that does not speak protocol 3.2 (postgres:16 by
//     default), asking for 3.2 plus an unrecognized _pq_.-prefixed option
//     produces a real NegotiateProtocolVersion: the server reports both the
//     downgrade to 3.0 and the unrecognized option in one message.
//   - against a real PostgreSQL 18 server, asking for 3.2 with no
//     unrecognized options negotiates nothing: there is no
//     NegotiateProtocolVersion at all, and BackendKeyData carries a real
//     32-byte secret key instead of the pre-3.2 fixed 4-byte one.
//
// There is nothing to run beyond connecting: the point is the startup
// exchange, and a query would only add Parse/Bind/Execute noise that the
// extended-query scenario already shows.
func protocol32(_ context.Context, _ *pgx.Conn) error {
	return nil
}

// --- streaming replication ---
//
// A replication connection is a normal wire connection that carries the
// startup parameter replication=true (physical) or replication=database
// (logical). pgconn (a level below pgx.Conn) already forwards any unrecognized
// connection-string parameter into that startup message, so it does the
// SSL/auth handshake for us. What it can't do is speak the sub-protocol that
// follows, so once connected we Hijack() to get the raw *pgproto3.Frontend
// and net.Conn and drive IDENTIFY_SYSTEM / CREATE_REPLICATION_SLOT /
// START_REPLICATION by hand, exactly as a real replication client would.
//
// pgReplicationEpoch mirrors internal/pgproto's: replication timestamps are
// microseconds since 2000-01-01 UTC.
var pgReplicationEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

// hijackReplicationConn connects with the given replication startup
// parameter and hands back the raw connection pgconn used underneath, post
// handshake.
func hijackReplicationConn(ctx context.Context, dsn, replication string) (*pgconn.HijackedConn, error) {
	cfg, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["replication"] = replication

	pgConn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pgConn.SyncConn(ctx); err != nil {
		pgConn.Close(ctx)
		return nil, fmt.Errorf("sync before hijack: %w", err)
	}
	return pgConn.Hijack()
}

// replicationCommand sends one of the replication-protocol pseudo-SQL
// commands (IDENTIFY_SYSTEM, CREATE_REPLICATION_SLOT, ...), which the server
// answers exactly like a simple Query: RowDescription, DataRow(s),
// CommandComplete, ReadyForQuery. It returns the last DataRow's values, which
// is enough since every command used here returns at most one row.
func replicationCommand(fe *pgproto3.Frontend, sql string) ([][]byte, error) {
	fe.Send(&pgproto3.Query{String: sql})
	if err := fe.Flush(); err != nil {
		return nil, fmt.Errorf("send %q: %w", sql, err)
	}
	var row [][]byte
	var cmdErr error
	for {
		msg, err := fe.Receive()
		if err != nil {
			return nil, fmt.Errorf("receive after %q: %w", sql, err)
		}
		switch m := msg.(type) {
		case *pgproto3.DataRow:
			row = m.Values
		case *pgproto3.ErrorResponse:
			// The simple query protocol still sends ReadyForQuery after an
			// ErrorResponse, so returning immediately here would leave it
			// unread: the next command's Receive would consume it instead of
			// its own reply, and every reply after that would be shifted by
			// one message. Remember the error and keep draining to
			// ReadyForQuery before returning.
			cmdErr = fmt.Errorf("%s: %s", sql, m.Message)
		case *pgproto3.ReadyForQuery:
			if cmdErr != nil {
				return nil, cmdErr
			}
			return row, nil
		}
	}
}

// parseLSN parses a Log Sequence Number in Postgres's "X/Y" hex form into the
// plain 64-bit position the wire protocol carries.
func parseLSN(s string) (uint64, error) {
	hi, lo, ok := strings.Cut(s, "/")
	if !ok {
		return 0, fmt.Errorf("not an LSN: %q", s)
	}
	hiV, err := strconv.ParseUint(hi, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad LSN %q: %w", s, err)
	}
	loV, err := strconv.ParseUint(lo, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad LSN %q: %w", s, err)
	}
	return hiV<<32 | loV, nil
}

// drainReplicationStream reads CopyData off a started replication stream,
// waiting up to maxWait for the first message, then only a short grace
// period after that so a burst of XLogData belonging to one transaction
// (Begin/Relation/Insert/Commit, say) is captured together rather than cut
// off after the first message. It remembers the last WAL position mentioned
// by either a keepalive or an XLogData message. The grace period stays
// short: the point is to show one real exchange, not to stream for the full
// timeout regardless of what arrives.
func drainReplicationStream(conn net.Conn, fe *pgproto3.Frontend, maxWait time.Duration) uint64 {
	const graceAfterFirst = 750 * time.Millisecond
	deadline := time.Now().Add(maxWait)
	var lastLSN uint64
	seenAny := false
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		msg, err := fe.Receive()
		if err != nil {
			break
		}
		cd, ok := msg.(*pgproto3.CopyData)
		if !ok || len(cd.Data) == 0 {
			continue
		}
		switch cd.Data[0] {
		case 'k': // Primary keepalive message: Byte1('k') Int64 end-of-WAL Int64 clock Byte1 reply?
			lastLSN = binary.BigEndian.Uint64(cd.Data[1:9])
		case 'w': // XLogData: Byte1('w') Int64 start Int64 end Int64 clock ...data
			lastLSN = binary.BigEndian.Uint64(cd.Data[9:17])
		default:
			continue
		}
		if !seenAny {
			seenAny = true
			deadline = time.Now().Add(graceAfterFirst)
		}
	}
	_ = conn.SetReadDeadline(time.Time{})
	return lastLSN
}

// sendStandbyStatusUpdate sends the frontend's half of the sub-protocol: a
// CopyData carrying a Standby status update reporting lsn as written,
// flushed and applied (a demo has nothing more precise to report), with no
// reply requested.
func sendStandbyStatusUpdate(fe *pgproto3.Frontend, lsn uint64) error {
	body := make([]byte, 1+8+8+8+8+1)
	body[0] = 'r'
	binary.BigEndian.PutUint64(body[1:9], lsn)
	binary.BigEndian.PutUint64(body[9:17], lsn)
	binary.BigEndian.PutUint64(body[17:25], lsn)
	binary.BigEndian.PutUint64(body[25:33], uint64(time.Since(pgReplicationEpoch).Microseconds()))
	body[33] = 0
	fe.Send(&pgproto3.CopyData{Data: body})
	return fe.Flush()
}

// endReplicationStream sends CopyDone to end the stream the documented way:
// the server answers with its own CopyDone, a CommandComplete and a
// ReadyForQuery, after which the connection is an ordinary idle connection
// again and Terminate closes it cleanly.
func endReplicationStream(fe *pgproto3.Frontend) error {
	fe.Send(&pgproto3.CopyDone{})
	if err := fe.Flush(); err != nil {
		return fmt.Errorf("send CopyDone: %w", err)
	}
	for {
		msg, err := fe.Receive()
		if err != nil {
			return fmt.Errorf("receive after CopyDone: %w", err)
		}
		switch m := msg.(type) {
		case *pgproto3.ErrorResponse:
			return fmt.Errorf("ending replication: %s", m.Message)
		case *pgproto3.ReadyForQuery:
			fe.Send(&pgproto3.Terminate{})
			return fe.Flush()
		}
	}
}

// replicationPhysical drives a physical replication connection: IDENTIFY_SYSTEM
// to find the current WAL position, a fresh physical slot, START_REPLICATION
// from that position, a real write on a second, ordinary connection so there
// is WAL activity to show (a walsender otherwise only speaks up every
// wal_sender_timeout/2, far slower than a short demo capture can wait), a
// read of the resulting XLogData, a Standby status update quoting it back,
// then a clean end.
//
// Everything that must not appear in the capture, the table's creation and a
// warm-up write, happens on setupDSN, a connection straight to Postgres that
// never touches the proxy. Only the replication connection (session 1) and
// the write it is streaming (session 2) are recorded.
//
// The warm-up row matters for the same reason it always did: Postgres logs a
// full 8KB page image the first time it touches a page after a checkpoint.
// The table's own heap page gets that treatment on its first write, so a
// throwaway row pays that cost on setupDSN before the replication connection
// even exists. The row inserted after START_REPLICATION then touches an
// already-dirtied page and logs a small delta record instead of a full image.
func replicationPhysical(ctx context.Context, dsn, setupDSN string) error {
	setup, err := pgx.Connect(ctx, setupDSN)
	if err != nil {
		return fmt.Errorf("connect (setup): %w", err)
	}
	defer setup.Close(ctx)
	const table = "pgwire_demo_physical_probe"
	if _, err := setup.Exec(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
		return fmt.Errorf("drop table: %w", err)
	}
	if _, err := setup.Exec(ctx, "CREATE TABLE "+table+" (id int PRIMARY KEY)"); err != nil {
		return fmt.Errorf("create table: %w", err)
	}
	// Autovacuum on this table could otherwise generate WAL of its own
	// while the replication stream is being drained below.
	if _, err := setup.Exec(ctx, "ALTER TABLE "+table+" SET (autovacuum_enabled = false)"); err != nil {
		return fmt.Errorf("disable autovacuum: %w", err)
	}
	// Warm-up row: pays the first-touch full-page-image cost for the
	// table's own heap page before the replication connection exists.
	if _, err := setup.Exec(ctx, "INSERT INTO "+table+" (id) VALUES (0)"); err != nil {
		return fmt.Errorf("warm-up insert: %w", err)
	}
	if err := setup.Close(ctx); err != nil {
		return fmt.Errorf("close setup: %w", err)
	}

	hc, err := hijackReplicationConn(ctx, dsn, "true")
	if err != nil {
		return fmt.Errorf("connect (replication): %w", err)
	}
	conn, fe := hc.Conn, hc.Frontend
	defer conn.Close()

	row, err := replicationCommand(fe, "IDENTIFY_SYSTEM")
	if err != nil {
		return fmt.Errorf("identify_system: %w", err)
	}
	if len(row) < 3 {
		return fmt.Errorf("IDENTIFY_SYSTEM: unexpected row %v", row)
	}
	startLSN := string(row[2])

	// Suffixed with the current time so the slot name cannot collide with one
	// left by an earlier run: there is nothing to clean up, so there is
	// nothing to DROP_REPLICATION_SLOT.
	slot := fmt.Sprintf("pgwire_demo_physical_%d", time.Now().UnixNano())
	if _, err := replicationCommand(fe, "CREATE_REPLICATION_SLOT "+slot+" PHYSICAL"); err != nil {
		return fmt.Errorf("create_replication_slot: %w", err)
	}

	fe.Send(&pgproto3.Query{String: "START_REPLICATION SLOT " + slot + " PHYSICAL " + startLSN})
	if err := fe.Flush(); err != nil {
		return fmt.Errorf("send start_replication: %w", err)
	}
	msg, err := fe.Receive()
	if err != nil {
		return fmt.Errorf("start_replication response: %w", err)
	}
	if _, ok := msg.(*pgproto3.CopyBothResponse); !ok {
		return fmt.Errorf("start_replication: expected CopyBothResponse, got %T", msg)
	}

	// The write actually shown in the capture: a second, ordinary connection
	// through the proxy, so it is session 2. Same table, already-dirtied
	// page, so this logs a small delta record rather than a full image.
	writer, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect (writer): %w", err)
	}
	if _, err := writer.Exec(ctx, "INSERT INTO "+table+" (id) VALUES (1)"); err != nil {
		writer.Close(ctx)
		return fmt.Errorf("insert: %w", err)
	}
	if err := writer.Close(ctx); err != nil {
		return fmt.Errorf("close writer: %w", err)
	}

	lastLSN := drainReplicationStream(conn, fe, 5*time.Second)
	if lastLSN == 0 {
		if lastLSN, err = parseLSN(startLSN); err != nil {
			return fmt.Errorf("no WAL position observed and start LSN unparseable: %w", err)
		}
	}
	if err := sendStandbyStatusUpdate(fe, lastLSN); err != nil {
		return fmt.Errorf("standby status update: %w", err)
	}
	return endReplicationStream(fe)
}

// replicationLogical drives a logical replication connection using the
// pgoutput plugin: the same plugin CREATE SUBSCRIPTION uses internally, so
// the capture shows the mechanism real logical replication runs on rather
// than test_decoding's debugging-only text format.
//
// The table and publication are created on setupDSN, straight to Postgres,
// so that scaffolding never touches the proxy. The slot is created and
// START_REPLICATION is sent and answered with CopyBothResponse BEFORE the
// write happens, on a second, ordinary connection through the proxy
// (session 2). That way the XLogData the stream carries is pgoutput decoding
// a commit as it happens, not catch-up replay of WAL already covered by the
// slot's consistent point.
func replicationLogical(ctx context.Context, dsn, setupDSN string) error {
	setup, err := pgx.Connect(ctx, setupDSN)
	if err != nil {
		return fmt.Errorf("connect (setup): %w", err)
	}

	const (
		table = "replication_demo"
		pub   = "pgwire_demo_pub"
	)
	if _, err := setup.Exec(ctx, "DROP PUBLICATION IF EXISTS "+pub); err != nil {
		setup.Close(ctx)
		return fmt.Errorf("drop publication: %w", err)
	}
	if _, err := setup.Exec(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
		setup.Close(ctx)
		return fmt.Errorf("drop table: %w", err)
	}
	if _, err := setup.Exec(ctx, "CREATE TABLE "+table+" (id int PRIMARY KEY, note text)"); err != nil {
		setup.Close(ctx)
		return fmt.Errorf("create table: %w", err)
	}
	if _, err := setup.Exec(ctx, "CREATE PUBLICATION "+pub+" FOR TABLE "+table); err != nil {
		setup.Close(ctx)
		return fmt.Errorf("create publication: %w", err)
	}
	if err := setup.Close(ctx); err != nil {
		return fmt.Errorf("close setup: %w", err)
	}

	hc, err := hijackReplicationConn(ctx, dsn, "database")
	if err != nil {
		return fmt.Errorf("connect (replication): %w", err)
	}
	conn, fe := hc.Conn, hc.Frontend
	defer conn.Close()

	// Suffixed with the current time so the slot name cannot collide with one
	// left by an earlier run: there is nothing to clean up, so there is
	// nothing to DROP_REPLICATION_SLOT.
	slot := fmt.Sprintf("pgwire_demo_logical_%d", time.Now().UnixNano())
	row, err := replicationCommand(fe, "CREATE_REPLICATION_SLOT "+slot+" LOGICAL pgoutput")
	if err != nil {
		return fmt.Errorf("create_replication_slot: %w", err)
	}
	if len(row) < 2 {
		return fmt.Errorf("CREATE_REPLICATION_SLOT: unexpected row %v", row)
	}
	consistentPoint := string(row[1])

	startCmd := fmt.Sprintf("START_REPLICATION SLOT %s LOGICAL %s (proto_version '1', publication_names '%s')",
		slot, consistentPoint, pub)
	fe.Send(&pgproto3.Query{String: startCmd})
	if err := fe.Flush(); err != nil {
		return fmt.Errorf("send start_replication: %w", err)
	}
	msg, err := fe.Receive()
	if err != nil {
		return fmt.Errorf("start_replication response: %w", err)
	}
	if em, ok := msg.(*pgproto3.ErrorResponse); ok {
		return fmt.Errorf("start_replication: %s: %s", em.Code, em.Message)
	}
	if _, ok := msg.(*pgproto3.CopyBothResponse); !ok {
		return fmt.Errorf("start_replication: expected CopyBothResponse, got %T", msg)
	}

	// The write actually shown in the capture, made only now that streaming
	// has started, on a second, ordinary connection through the proxy
	// (session 2): the XLogData that follows is this commit being decoded
	// live, not replay of something already committed before we streamed.
	writer, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect (writer): %w", err)
	}
	if _, err := writer.Exec(ctx, "INSERT INTO "+table+" (id, note) VALUES (1, 'hello from logical replication')"); err != nil {
		writer.Close(ctx)
		return fmt.Errorf("insert: %w", err)
	}
	if err := writer.Close(ctx); err != nil {
		return fmt.Errorf("close writer: %w", err)
	}

	lastLSN := drainReplicationStream(conn, fe, 5*time.Second)
	if lastLSN == 0 {
		if lastLSN, err = parseLSN(consistentPoint); err != nil {
			return fmt.Errorf("no WAL position observed and consistent point unparseable: %w", err)
		}
	}
	if err := sendStandbyStatusUpdate(fe, lastLSN); err != nil {
		return fmt.Errorf("standby status update: %w", err)
	}
	return endReplicationStream(fe)
}
