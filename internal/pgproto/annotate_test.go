package pgproto

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5/pgproto3"
)

// checkInvariants asserts the two properties the explorer UI depends on to
// wire its field tree to a hex dump:
//
//  1. The top-level Bytes ranges tile the packet EXACTLY: every byte covered
//     once, no gaps, no overlaps, nothing out of range. A gap means bytes the
//     UI can show but not explain. An overlap means one byte highlighting two
//     rows.
//  2. Every child's range lies within its parent's, and children are ordered
//     and non-overlapping among themselves.
//
// These are the invariants that a hand-written offset calculation gets wrong,
// which is exactly why annotate.go computes offsets by hand rather than via a
// generic cursor, so they need a test rather than a type system.
func checkInvariants(t *testing.T, label string, fields []FieldAnnotation, packetLen int) {
	t.Helper()

	if len(fields) == 0 {
		t.Errorf("%s: no field annotations for a %d-byte packet", label, packetLen)
		return
	}

	checkGroup(t, label, fields, 0, packetLen-1)
}

// checkGroup verifies that fields tile [lo, hi] exactly, then recurses.
func checkGroup(t *testing.T, label string, fields []FieldAnnotation, lo, hi int) {
	t.Helper()

	// Sort by start so a decoder emitting fields out of order still reports as
	// a coverage problem rather than as spurious "overlap" noise.
	idx := make([]int, len(fields))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		return fields[idx[a]].Bytes[0] < fields[idx[b]].Bytes[0]
	})

	want := lo
	for _, i := range idx {
		f := fields[i]
		start, end := f.Bytes[0], f.Bytes[1]
		path := label + "/" + f.Name

		// An empty value legitimately annotates zero bytes, encoded as
		// end == start-1 (see fRawBytes / fLengthPrefixedOrNull).
		if end == start-1 {
			if start < lo || start > hi+1 {
				t.Errorf("%s: empty range [%d,%d] outside [%d,%d]", path, start, end, lo, hi)
			}
			continue
		}

		if start < lo || end > hi {
			t.Errorf("%s: range [%d,%d] escapes parent [%d,%d]", path, start, end, lo, hi)
			continue
		}
		if end < start {
			t.Errorf("%s: inverted range [%d,%d]", path, start, end)
			continue
		}
		if start < want {
			t.Errorf("%s: range [%d,%d] overlaps previous field (expected to start at %d)", path, start, end, want)
		} else if start > want {
			t.Errorf("%s: gap of %d unexplained byte(s) at [%d,%d] before range [%d,%d]",
				path, start-want, want, start-1, start, end)
		}
		want = end + 1

		if len(f.Children) > 0 {
			checkGroup(t, path, f.Children, start, end)
		}
	}

	if want != hi+1 {
		t.Errorf("%s: %d trailing unexplained byte(s) at [%d,%d]", label, hi+1-want, want, hi)
	}
}

// encode renders msg to its complete wire bytes, header included.
func encode(t *testing.T, msg pgproto3.Message) []byte {
	t.Helper()
	raw, err := msg.Encode(nil)
	if err != nil {
		t.Fatalf("encode %T: %v", msg, err)
	}
	return raw
}

// TestAnnotateInvariants round-trips every message type through pgproto3's own
// encoder and back through Decode, so the whole annotated message set is
// covered without hand-writing hex. pgproto3 produces the bytes, so a
// disagreement here is ours: our offsets do not match how pgproto3 (and
// therefore Postgres) actually lays the message out.
func TestAnnotateInvariants(t *testing.T) {
	cases := []struct {
		msg      pgproto3.Message
		dir      Direction
		authType uint32 // only needed to disambiguate the overloaded FE tag 'p'
	}{
		// ---- Frontend (C2S) ----
		{msg: &pgproto3.Query{String: "SELECT 1;"}, dir: ClientToServer},
		{msg: &pgproto3.Query{String: ""}, dir: ClientToServer},
		{msg: &pgproto3.Parse{Name: "s1", Query: "SELECT $1::int, $2::text", ParameterOIDs: []uint32{23, 25}}, dir: ClientToServer},
		{msg: &pgproto3.Parse{Name: "", Query: "SELECT 1", ParameterOIDs: nil}, dir: ClientToServer},
		{msg: &pgproto3.Bind{
			DestinationPortal:    "p1",
			PreparedStatement:    "s1",
			ParameterFormatCodes: []int16{0, 1},
			Parameters:           [][]byte{[]byte("42"), nil}, // nil == SQL NULL
			ResultFormatCodes:    []int16{1},
		}, dir: ClientToServer},
		{msg: &pgproto3.Bind{}, dir: ClientToServer},
		{msg: &pgproto3.Describe{ObjectType: 'S', Name: "s1"}, dir: ClientToServer},
		{msg: &pgproto3.Describe{ObjectType: 'P', Name: ""}, dir: ClientToServer},
		{msg: &pgproto3.Execute{Portal: "p1", MaxRows: 100}, dir: ClientToServer},
		{msg: &pgproto3.Close{ObjectType: 'S', Name: "s1"}, dir: ClientToServer},
		{msg: &pgproto3.Flush{}, dir: ClientToServer},
		{msg: &pgproto3.Sync{}, dir: ClientToServer},
		{msg: &pgproto3.Terminate{}, dir: ClientToServer},
		{msg: &pgproto3.CopyFail{Message: "client gave up"}, dir: ClientToServer},
		{msg: &pgproto3.FunctionCall{
			Function:         42,
			ArgFormatCodes:   []uint16{0, 1},
			Arguments:        [][]byte{[]byte("a"), nil},
			ResultFormatCode: 1,
		}, dir: ClientToServer},

		// Tag 'p' is overloaded. authType is what resolves it.
		{msg: &pgproto3.PasswordMessage{Password: "hunter2"}, dir: ClientToServer, authType: pgproto3.AuthTypeCleartextPassword},
		{msg: &pgproto3.SASLInitialResponse{AuthMechanism: "SCRAM-SHA-256", Data: []byte("n,,n=,r=abc")}, dir: ClientToServer, authType: pgproto3.AuthTypeSASL},
		{msg: &pgproto3.SASLResponse{Data: []byte("c=biws,r=abc,p=xyz")}, dir: ClientToServer, authType: pgproto3.AuthTypeSASLContinue},
		{msg: &pgproto3.GSSResponse{Data: []byte{0x01, 0x02, 0x03}}, dir: ClientToServer, authType: pgproto3.AuthTypeGSS},

		// ---- Backend (S2C) ----
		{msg: &pgproto3.AuthenticationOk{}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationCleartextPassword{}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationMD5Password{Salt: [4]byte{1, 2, 3, 4}}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationGSS{}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationGSSContinue{Data: []byte{9, 8, 7}}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationSASL{AuthMechanisms: []string{"SCRAM-SHA-256", "SCRAM-SHA-256-PLUS"}}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationSASLContinue{Data: []byte("r=abc,s=def,i=4096")}, dir: ServerToClient},
		{msg: &pgproto3.AuthenticationSASLFinal{Data: []byte("v=xyz")}, dir: ServerToClient},
		// SecretKey is variable-length as of protocol 3.2 (4 bytes under 3.0).
		{msg: &pgproto3.BackendKeyData{ProcessID: 1234, SecretKey: []byte{0, 0, 22, 46}}, dir: ServerToClient},
		{msg: &pgproto3.BackendKeyData{ProcessID: 1234, SecretKey: []byte("a-longer-3.2-secret-key")}, dir: ServerToClient},
		{msg: &pgproto3.ParameterStatus{Name: "server_version", Value: "17.2"}, dir: ServerToClient},
		{msg: &pgproto3.ReadyForQuery{TxStatus: 'I'}, dir: ServerToClient},
		{msg: &pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{
			{Name: []byte("id"), TableOID: 1, TableAttributeNumber: 1, DataTypeOID: 23, DataTypeSize: 4, TypeModifier: -1, Format: 0},
			{Name: []byte("name"), TableOID: 1, TableAttributeNumber: 2, DataTypeOID: 25, DataTypeSize: -1, TypeModifier: -1, Format: 1},
		}}, dir: ServerToClient},
		{msg: &pgproto3.RowDescription{Fields: nil}, dir: ServerToClient},
		{msg: &pgproto3.DataRow{Values: [][]byte{[]byte("1"), nil, {}}}, dir: ServerToClient}, // value, NULL, empty
		{msg: &pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")}, dir: ServerToClient},
		{msg: &pgproto3.EmptyQueryResponse{}, dir: ServerToClient},
		{msg: &pgproto3.ParseComplete{}, dir: ServerToClient},
		{msg: &pgproto3.BindComplete{}, dir: ServerToClient},
		{msg: &pgproto3.CloseComplete{}, dir: ServerToClient},
		{msg: &pgproto3.NoData{}, dir: ServerToClient},
		{msg: &pgproto3.PortalSuspended{}, dir: ServerToClient},
		{msg: &pgproto3.ErrorResponse{
			Severity: "ERROR", Code: "42P01", Message: `relation "nope" does not exist`,
			Position: 15, File: "parse_relation.c", Line: 1381, Routine: "parserOpenTable",
		}, dir: ServerToClient},
		{msg: &pgproto3.NoticeResponse{Severity: "NOTICE", Code: "00000", Message: "heads up"}, dir: ServerToClient},
		{msg: &pgproto3.ParameterDescription{ParameterOIDs: []uint32{23, 25}}, dir: ServerToClient},
		{msg: &pgproto3.ParameterDescription{ParameterOIDs: nil}, dir: ServerToClient},
		{msg: &pgproto3.NotificationResponse{PID: 99, Channel: "chan", Payload: "hello"}, dir: ServerToClient},
		{msg: &pgproto3.NegotiateProtocolVersion{NewestMinorProtocol: 0, UnrecognizedOptions: []string{"foo", "bar"}}, dir: ServerToClient},
		{msg: &pgproto3.NegotiateProtocolVersion{NewestMinorProtocol: 2, UnrecognizedOptions: nil}, dir: ServerToClient},
		{msg: &pgproto3.CopyInResponse{OverallFormat: 0, ColumnFormatCodes: []uint16{0, 0}}, dir: ServerToClient},
		{msg: &pgproto3.CopyOutResponse{OverallFormat: 1, ColumnFormatCodes: []uint16{1}}, dir: ServerToClient},
		{msg: &pgproto3.CopyBothResponse{OverallFormat: 0, ColumnFormatCodes: nil}, dir: ServerToClient},
		{msg: &pgproto3.FunctionCallResponse{Result: []byte("result")}, dir: ServerToClient},
		{msg: &pgproto3.FunctionCallResponse{Result: nil}, dir: ServerToClient},
		{msg: &pgproto3.CopyData{Data: []byte("1\t2\n")}, dir: ServerToClient},
		{msg: &pgproto3.CopyDone{}, dir: ServerToClient},
	}

	seen := map[string]bool{}

	for _, tc := range cases {
		name := fmt.Sprintf("%s/%s", tc.dir, messageName(tc.msg))
		t.Run(name, func(t *testing.T) {
			raw := encode(t, tc.msg)
			d := Decode(tc.dir, raw, tc.authType)

			if want := messageName(tc.msg); d.TypeName != want {
				t.Fatalf("TypeName = %q, want %q (raw %s)", d.TypeName, want, hex.EncodeToString(raw))
			}
			if d.TypeChar != string(raw[0]) {
				t.Errorf("TypeChar = %q, want %q", d.TypeChar, string(raw[0]))
			}
			checkInvariants(t, name, d.Fields, len(raw))
		})
		seen[messageName(tc.msg)] = true
	}

	// Guard against a message type being added to annotate.go without a case
	// here. The annotator would silently fall through to its default and emit
	// an unhelpful raw payload.
	t.Run("coverage", func(t *testing.T) {
		for _, name := range annotatedMessageNames() {
			if !seen[name] {
				t.Errorf("annotate.go handles %s but no test case exercises it", name)
			}
		}
	})
}

// TestFieldValuesSurviveJSON pins losslessness. Annotations are delivered to
// the UI as JSON, and json.Marshal silently rewrites invalid UTF-8 to U+FFFD.
// So any field whose value is a Go string built from arbitrary bytes has to be
// hex-encoded by displayBytes, or the capture records replacement characters
// that can never be decoded back.
//
// The cases below are the ones that actually carry arbitrary bytes: an MD5 salt
// is random, and binary-format column values are whatever the type sends.
func TestFieldValuesSurviveJSON(t *testing.T) {
	// High bytes (0x80+) are the trap: >= 0x20, so an "is it printable" check
	// passes, but not valid UTF-8 on their own.
	binaryBlob := []byte{0xde, 0xad, 0xbe, 0xef, 0x80, 0xff, 0x41, 0x00}

	cases := []struct {
		name string
		dir  Direction
		msg  pgproto3.Message
	}{
		{"AuthenticationMD5Password", ServerToClient, &pgproto3.AuthenticationMD5Password{Salt: [4]byte{0x9b, 0x51, 0x27, 0xe4}}},
		{"AuthenticationSASLContinue", ServerToClient, &pgproto3.AuthenticationSASLContinue{Data: binaryBlob}},
		{"AuthenticationGSSContinue", ServerToClient, &pgproto3.AuthenticationGSSContinue{Data: binaryBlob}},
		{"DataRow/binary", ServerToClient, &pgproto3.DataRow{Values: [][]byte{binaryBlob, []byte("plain text")}}},
		{"CopyData/binary", ServerToClient, &pgproto3.CopyData{Data: binaryBlob}},
		{"Bind/binary param", ClientToServer, &pgproto3.Bind{Parameters: [][]byte{binaryBlob}, ParameterFormatCodes: []int16{1}}},
		{"FunctionCallResponse", ServerToClient, &pgproto3.FunctionCallResponse{Result: binaryBlob}},
		// Valid multi-byte UTF-8 must stay readable rather than being hexed.
		{"Query/unicode", ClientToServer, &pgproto3.Query{String: "SELECT 'café ☕';"}},
		{"CommandComplete/unicode", ServerToClient, &pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := Decode(tc.dir, encode(t, tc.msg), 0)

			once, err := json.Marshal(d.Fields)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if bytes.Contains(once, []byte("\\ufffd")) {
				t.Errorf("a field value was mangled to U+FFFD, so the capture is lossy: %s", once)
			}

			// Marshal -> unmarshal -> marshal must be a fixed point. If the
			// first marshal lost information, the second differs.
			var back []FieldAnnotation
			if err := json.Unmarshal(once, &back); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			twice, err := json.Marshal(back)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			if !bytes.Equal(once, twice) {
				t.Errorf("annotations do not survive a JSON round trip\n once: %s\ntwice: %s", once, twice)
			}
		})
	}
}

// TestUnicodeStaysReadable is the other half of the losslessness fix: hex is the
// fallback for binary, not the default. A query containing multi-byte UTF-8 must
// still be shown as text, or the tool stops being readable for anyone whose data
// is not ASCII.
func TestUnicodeStaysReadable(t *testing.T) {
	const sql = "SELECT 'café ☕ 日本語';"
	d := Decode(ClientToServer, encode(t, &pgproto3.Query{String: sql}), 0)

	last := d.Fields[len(d.Fields)-1]
	if last.Value != sql {
		t.Errorf("SQL rendered as %q, want %q", last.Value, sql)
	}
}

// beInt64 and beInt32 build big-endian field bytes for the hand-crafted
// replication submessages below. pgproto3 has no encoder for the streaming
// replication sub-protocol (it treats CopyData as opaque), so unlike the rest
// of this file, these payloads are built by hand rather than round-tripped
// through pgproto3.
func beInt64(v int64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(v))
	return b
}

func beInt32(v int32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(v))
	return b
}

// TestReplicationSubProtocolInvariants covers the four CopyData submessages
// used by streaming replication (see protocol-replication.html). These ride
// inside CopyData, which pgproto3 treats as opaque, so annotate.go decodes
// them by hand and these cases build the payloads by hand too.
func TestReplicationSubProtocolInvariants(t *testing.T) {
	cases := []struct {
		name string
		dir  Direction
		data []byte
	}{
		{
			name: "XLogData",
			dir:  ServerToClient,
			data: concat([]byte("w"), beInt64(100), beInt64(200), beInt64(1234567), []byte("BEGIN;COMMIT;")),
		},
		{
			name: "XLogData/zero-length WAL data",
			dir:  ServerToClient,
			data: concat([]byte("w"), beInt64(100), beInt64(200), beInt64(1234567)),
		},
		{
			name: "PrimaryKeepaliveMessage",
			dir:  ServerToClient,
			data: concat([]byte("k"), beInt64(300), beInt64(1234567), []byte{1}),
		},
		{
			name: "StandbyStatusUpdate",
			dir:  ClientToServer,
			data: concat([]byte("r"), beInt64(100), beInt64(90), beInt64(80), beInt64(1234567), []byte{0}),
		},
		{
			name: "HotStandbyFeedbackMessage",
			dir:  ClientToServer,
			data: concat([]byte("h"), beInt64(1234567), beInt32(500), beInt32(1), beInt32(400), beInt32(1)),
		},
		// A payload that starts with a replication subtype byte but is the
		// wrong length for it (truncated CopyData, or plain COPY row data
		// that happens to start with 'w') must fall back to the plain raw
		// rendering rather than guessing at a decode.
		{
			name: "malformed keepalive falls back to raw",
			dir:  ServerToClient,
			data: []byte("k too short"),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := encode(t, &pgproto3.CopyData{Data: tc.data})
			d := Decode(tc.dir, raw, 0)
			if d.TypeName != "CopyData" {
				t.Fatalf("TypeName = %q, want CopyData", d.TypeName)
			}
			checkInvariants(t, tc.name, d.Fields, len(raw))
		})
	}
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// TestStartupFormatInvariants covers the untagged messages, which have no
// pgproto3 encoder path through Backend.Receive and so are annotated by hand.
func TestStartupFormatInvariants(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		{"StartupMessage", startupMsgWithCode(CodeStartup, map[string]string{"user": "postgres", "database": "postgres"})},
		{"StartupMessage/no params", startupMsgWithCode(CodeStartup, nil)},
		// Protocol 3.2 (PostgreSQL 18) uses request code 196610, not 196608.
		// The frame is otherwise identical: the framer only needs to recognize
		// the code, not decode it any differently.
		{"StartupMessage/3.2", startupMsgWithCode(CodeStartup32, map[string]string{"user": "postgres", "database": "postgres"})},
		{"SSLRequest", untagged(CodeSSL, nil)},
		{"GSSENCRequest", untagged(CodeGSSENC, nil)},
		// Before 3.2 the secret key was always exactly 4 bytes. As of 3.2 it is
		// 4-256 bytes, extending to the end of the message, so both lengths
		// need to tile correctly.
		{"CancelRequest", untagged(CodeCancel, []byte{0, 0, 4, 210, 0, 0, 22, 46})},
		{"CancelRequest/3.2 longer secret key", untagged(CodeCancel, append([]byte{0, 0, 4, 210}, []byte("a-longer-3.2-secret-key")...))},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := Decode(ClientToServer, tc.raw, 0)
			if d.TypeName == "" || d.TypeName == "Unknown" {
				t.Fatalf("TypeName = %q for %s", d.TypeName, hex.EncodeToString(tc.raw))
			}
			if d.TypeChar != "" {
				t.Errorf("TypeChar = %q, want empty (startup-format messages are untagged)", d.TypeChar)
			}
			checkInvariants(t, tc.name, d.Fields, len(tc.raw))
		})
	}
}

// untagged builds a startup-format message: Int32 length (self-inclusive),
// Int32 request code, then body.
func untagged(code uint32, body []byte) []byte {
	raw := make([]byte, 8, 8+len(body))
	total := uint32(8 + len(body))
	raw[0], raw[1], raw[2], raw[3] = byte(total>>24), byte(total>>16), byte(total>>8), byte(total)
	raw[4], raw[5], raw[6], raw[7] = byte(code>>24), byte(code>>16), byte(code>>8), byte(code)
	return append(raw, body...)
}

func startupMsg(params map[string]string) []byte {
	return startupMsgWithCode(CodeStartup, params)
}

func startupMsgWithCode(code uint32, params map[string]string) []byte {
	var body []byte
	// Sorted for determinism. The protocol does not care about order.
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		body = append(body, k...)
		body = append(body, 0)
		body = append(body, params[k]...)
		body = append(body, 0)
	}
	body = append(body, 0) // parameter list terminator
	return untagged(code, body)
}

// TestDecodeNeverFails pins the contract the proxy relies on: no input makes
// Decode panic or return a nameless packet, because a decoder bug must degrade
// to a bad annotation rather than kill a goroutine relaying live traffic.
func TestDecodeNeverFails(t *testing.T) {
	inputs := [][]byte{
		{},
		{'Q'},
		{'Q', 0, 0, 0},
		{'Q', 0, 0, 0, 4},
		{'Q', 0, 0, 0, 99, 'S', 'E', 'L'},       // length longer than the data
		{'Q', 0, 0, 0, 5, 'S', 'E', 'L', 'E'},   // length shorter than the data
		{'\xff', 0, 0, 0, 4},                    // unknown tag
		{'T', 0, 0, 0, 6, 0xff, 0xff},           // RowDescription claiming 65535 columns
		{'D', 0, 0, 0, 6, 0x7f, 0xff},           // DataRow claiming 32767 columns
		{'p', 0, 0, 0, 4},                       // overloaded tag, no auth state
		untagged(CodeStartup, []byte{'u', 'x'}), // unterminated parameter
		untagged(0xdeadbeef, nil),               // unrecognized request code
		{0, 0, 0, 0},
		{0, 0, 0, 8, 0, 0, 0},
	}

	for _, dir := range []Direction{ClientToServer, ServerToClient} {
		for i, raw := range inputs {
			t.Run(fmt.Sprintf("%s/%d", dir, i), func(t *testing.T) {
				d := Decode(dir, raw, 0) // must not panic
				if d.TypeName == "" {
					t.Errorf("empty TypeName for %s. Every frame must be named", hex.EncodeToString(raw))
				}
				if len(raw) > 0 {
					checkRangesInBounds(t, d.Fields, len(raw))
				}
			})
		}
	}
}

// checkRangesInBounds is the weaker check used for malformed input. Exact tiling
// is not expected when decoding failed, but no annotation may ever point outside
// the packet, or the UI would index out of its hex dump.
func checkRangesInBounds(t *testing.T, fields []FieldAnnotation, packetLen int) {
	t.Helper()
	for _, f := range fields {
		s, e := f.Bytes[0], f.Bytes[1]
		if s < 0 || s > packetLen || e >= packetLen && e != s-1 {
			t.Errorf("%s: range [%d,%d] out of bounds for %d-byte packet", f.Name, s, e, packetLen)
		}
		checkRangesInBounds(t, f.Children, packetLen)
	}
}

// FuzzDecode is the same contract as TestDecodeNeverFails, over arbitrary
// bytes: any input the fuzzer finds that panics is a bug that would take down
// the proxy mid-capture.
func FuzzDecode(f *testing.F) {
	f.Add([]byte{'Q', 0, 0, 0, 9, 'S', 'E', 'L', 0}, true, uint32(0))
	f.Add([]byte{'T', 0, 0, 0, 6, 0, 1}, false, uint32(0))
	f.Add(untagged(CodeStartup, []byte{'u', 's', 'e', 'r', 0, 'x', 0, 0}), true, uint32(0))
	f.Add([]byte{'E', 0, 0, 0, 10, 'S', 'F', 'A', 'T', 'A', 0}, false, uint32(0))
	f.Add([]byte{'p', 0, 0, 0, 8, 1, 2, 3, 4}, true, uint32(pgproto3.AuthTypeSASL))

	f.Fuzz(func(t *testing.T, raw []byte, c2s bool, authType uint32) {
		dir := ServerToClient
		if c2s {
			dir = ClientToServer
		}
		d := Decode(dir, raw, authType)
		if d.TypeName == "" {
			t.Errorf("empty TypeName for %s", hex.EncodeToString(raw))
		}
		if len(raw) > 0 {
			checkRangesInBounds(t, d.Fields, len(raw))
		}
	})
}

// TestProtocolVersionsAreDecoded pins the rendering of the two fields that
// carry a protocol version code. Both are Int32s that read as a meaningless
// large number on their own, so they are rendered as major.minor with the raw
// value beside it. NegotiateProtocolVersion is the subtle one: the docs call
// its field a minor version, but the server sends a whole version code, so it
// has to be decoded the same way StartupMessage's is.
func TestProtocolVersionsAreDecoded(t *testing.T) {
	cases := []struct {
		label string
		raw   []byte
		field string
		want  string
	}{
		{"startup 3.0", startupMsgWithCode(196608, map[string]string{"user": "u"}), "Protocol Version", "3.0 (196608)"},
		{"startup 3.2", startupMsgWithCode(196610, map[string]string{"user": "u"}), "Protocol Version", "3.2 (196610)"},
		{
			"negotiate 3.0",
			encode(t, &pgproto3.NegotiateProtocolVersion{NewestMinorProtocol: 196608}),
			"Newest Minor Protocol", "3.0 (196608)",
		},
		{
			"negotiate 3.2",
			encode(t, &pgproto3.NegotiateProtocolVersion{NewestMinorProtocol: 196610}),
			"Newest Minor Protocol", "3.2 (196610)",
		},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			dir := ServerToClient
			if tc.field == "Protocol Version" {
				dir = ClientToServer
			}
			d := Decode(dir, tc.raw, 0)
			var got string
			for _, f := range d.Fields {
				if f.Name == tc.field {
					s, ok := f.Value.(string)
					if !ok {
						t.Fatalf("%s is %T, want a decoded string", tc.field, f.Value)
					}
					got = s
				}
			}
			if got != tc.want {
				t.Errorf("%s = %q, want %q", tc.field, got, tc.want)
			}
		})
	}
}

// TestAuthSSPI covers the one Authentication message pgproto3 refuses, so
// TestAnnotateInvariants above cannot reach it.
//
// Hand-written bytes, which every other case here deliberately avoids. There is
// no pgproto3 struct to round-trip through, which is the whole reason annotate.go
// handles this one itself. The layout is fully specified as nine bytes, the tag,
// Int32(8) and the code, so writing it out is exact rather than a guess.
func TestAuthSSPI(t *testing.T) {
	raw := []byte{'R', 0, 0, 0, 8, 0, 0, 0, 9}
	d := Decode(ServerToClient, raw, 0)

	if d.TypeName != "AuthenticationSSPI" {
		t.Fatalf("TypeName = %q, want AuthenticationSSPI", d.TypeName)
	}
	if d.TypeChar != "R" {
		t.Errorf("TypeChar = %q, want R", d.TypeChar)
	}
	// The session has to remember it, or the tag 'p' reply below cannot be
	// resolved at all.
	if !d.AuthTypeKnown || d.AuthType != 9 {
		t.Errorf("AuthType = %d (known %v), want 9 (known true)", d.AuthType, d.AuthTypeKnown)
	}
	checkInvariants(t, "AuthenticationSSPI", d.Fields, len(raw))
}

// TestAuthSSPIRejectsOtherCodes pins the two codes deliberately left undecoded,
// so removing them from the guard cannot pass unnoticed. Both still render as
// Unknown, which is what TestProtocolCoverage records and why.
func TestAuthSSPIRejectsOtherCodes(t *testing.T) {
	for _, tc := range []struct {
		code uint32
		name string
	}{
		{code: 2, name: "KerberosV5"},
		{code: 6, name: "SCMCredential"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte{'R', 0, 0, 0, 8, 0, 0, 0, byte(tc.code)}
			if d := Decode(ServerToClient, raw, 0); d.TypeName != "Unknown" {
				t.Errorf("TypeName = %q, want Unknown", d.TypeName)
			}
		})
	}
}

// TestSSPITokenDecodesAsGSSResponse pins the translation Decode makes when
// resolving the overloaded tag 'p' after an SSPI request.
//
// pgproto3 has no case for auth type 9 there, so without it the token falls
// through to PasswordMessage and a binary blob is read as a C string called
// "Password". The protocol carries SSPI data in GSSResponse. The token here holds
// a NUL and a high byte, which is exactly what a C-string read would mangle.
func TestSSPITokenDecodesAsGSSResponse(t *testing.T) {
	token := []byte{'N', 'T', 'L', 'M', 'S', 'S', 'P', 0x00, 0x01, 0xff}
	raw := append([]byte{'p', 0, 0, 0, byte(4 + len(token))}, token...)

	d := Decode(ClientToServer, raw, 9)
	if d.TypeName != "GSSResponse" {
		t.Fatalf("TypeName = %q, want GSSResponse", d.TypeName)
	}
	if got := find(t, d.Fields, "GSS Data").Value; got != hex.EncodeToString(token) {
		t.Errorf("GSS Data = %v, want %s", got, hex.EncodeToString(token))
	}
	checkInvariants(t, "GSSResponse", d.Fields, len(raw))
}
