package capture

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"pgwire-explorer/internal/pgproto"
)

var update = flag.Bool("update", false, "rewrite the golden capture in testdata from the current decoder")

const goldenPath = "../../testdata/session.json"

// TestReplayGolden is the golden test, and it is deliberately self-hosting:
// testdata/session.json is a real capture recorded by the proxy, and the test
// re-decodes each packet's own raw_hex and asserts the result still matches
// the type name and full field tree stored beside it.
//
// So the fixture is both input and expectation. Any change to annotate.go that
// alters what a real psql session decodes to shows up here as a diff, and
// regenerating it is either `go test ./internal/capture -update` or simply
// recording a fresh session with the proxy.
//
// Replay is per-session and in order, because decoding is not stateless: the
// auth type carried by a BE Authentication* message is what disambiguates a
// later FE tag 'p'. Replaying in order exercises that state machine too.
func TestReplayGolden(t *testing.T) {
	capture := loadGolden(t)

	if capture.Version != SchemaVersion {
		t.Errorf("golden capture is schema %q, current is %q. Re-record it", capture.Version, SchemaVersion)
	}
	if len(capture.Sessions) == 0 {
		t.Fatal("golden capture has no sessions")
	}

	changed := false
	for _, sess := range capture.Sessions {
		var authType uint32
		for i := range sess.Packets {
			pkt := &sess.Packets[i]

			raw, err := hex.DecodeString(pkt.RawHex)
			if err != nil {
				t.Fatalf("session %d packet %d: bad raw_hex: %v", sess.ID, pkt.ID, err)
			}
			if len(raw) != pkt.Length {
				t.Errorf("session %d packet %d: raw_hex is %d bytes but length says %d",
					sess.ID, pkt.ID, len(raw), pkt.Length)
			}

			// The reply to SSLRequest is a bare byte rather than a wire
			// message, so there is nothing for the decoder to re-derive. But it
			// must still be annotated, or the UI hits a packet it cannot
			// explain.
			if !isWireMessage(pkt) {
				if len(pkt.Fields) == 0 {
					t.Errorf("session %d packet %d (%s): packet has no fields",
						sess.ID, pkt.ID, pkt.TypeName)
				}
				continue
			}

			d := pgproto.Decode(pgproto.Direction(pkt.Direction), raw, authType)
			if d.AuthTypeKnown {
				authType = d.AuthType
			}

			if d.TypeName != pkt.TypeName {
				t.Errorf("session %d packet %d: TypeName = %q, golden has %q",
					sess.ID, pkt.ID, d.TypeName, pkt.TypeName)
				changed = true
			}
			if d.TypeChar != pkt.TypeChar {
				t.Errorf("session %d packet %d (%s): TypeChar = %q, golden has %q",
					sess.ID, pkt.ID, pkt.TypeName, d.TypeChar, pkt.TypeChar)
				changed = true
			}
			// Compared as JSON, not with reflect.DeepEqual: FieldAnnotation.Value
			// is an interface{}, so a value the decoder produces as uint32(8)
			// comes back out of the golden file as float64(8). JSON is also the
			// form the UI actually consumes, so it is the representation that
			// matters.
			if got, want := mustJSON(d.Fields), mustJSON(pkt.Fields); got != want {
				t.Errorf("session %d packet %d (%s): field tree changed\n got: %s\nwant: %s",
					sess.ID, pkt.ID, pkt.TypeName, got, want)
				changed = true
			}

			if *update {
				pkt.TypeName, pkt.TypeChar, pkt.Fields = d.TypeName, d.TypeChar, d.Fields
			}
		}
	}

	if *update {
		writeGolden(t, capture)
		t.Log("golden capture rewritten. Re-run without -update")
		return
	}
	if changed {
		t.Log("if these changes are intended, re-run with -update")
	}
}

// TestGoldenCoverage checks the fixture is still worth having: a capture that
// lost its interesting packets would let the golden test pass vacuously.
func TestGoldenCoverage(t *testing.T) {
	capture := loadGolden(t)

	seen := map[string]bool{}
	var c2s, s2c int
	for _, sess := range capture.Sessions {
		for _, pkt := range sess.Packets {
			seen[pkt.TypeName] = true
			switch pkt.Direction {
			case string(pgproto.ClientToServer):
				c2s++
			case string(pgproto.ServerToClient):
				s2c++
			default:
				t.Errorf("session %d packet %d: unknown direction %q", sess.ID, pkt.ID, pkt.Direction)
			}
		}
	}

	// A capture that exercises the full connection lifecycle: negotiation,
	// startup, auth, a query with its result, and teardown.
	for _, want := range []string{
		"SSLRequest", "StartupMessage", "AuthenticationOk", "ParameterStatus",
		"BackendKeyData", "ReadyForQuery", "Query", "RowDescription",
		"Terminate", "CancelRequest",
	} {
		if !seen[want] {
			t.Errorf("golden capture no longer contains a %s packet", want)
		}
	}
	if seen["Unknown"] {
		t.Error("golden capture contains an Unknown packet. A real session should decode fully")
	}
	if c2s == 0 || s2c == 0 {
		t.Errorf("golden capture is one-directional (C2S=%d, S2C=%d)", c2s, s2c)
	}
}

// TestSessionsAreWellFormed pins the structural guarantees the UI reads the
// capture with: per-session packet IDs are dense and 1-based, timestamps are
// monotonic within a session, and each direction's stream offsets are
// contiguous (offset + length == next offset), since the UI reconstructs each
// byte stream from them.
func TestSessionsAreWellFormed(t *testing.T) {
	capture := loadGolden(t)

	for _, sess := range capture.Sessions {
		offsets := map[string]int64{}
		var lastTS float64

		for i, pkt := range sess.Packets {
			if pkt.ID != i+1 {
				t.Errorf("session %d: packet at index %d has ID %d", sess.ID, i, pkt.ID)
			}
			if pkt.TypeName == "" {
				t.Errorf("session %d packet %d: empty TypeName", sess.ID, pkt.ID)
			}
			if pkt.TimestampMs < lastTS {
				t.Errorf("session %d packet %d: timestamp %.3fms goes backwards from %.3fms",
					sess.ID, pkt.ID, pkt.TimestampMs, lastTS)
			}
			lastTS = pkt.TimestampMs

			if want := offsets[pkt.Direction]; pkt.StreamOffset != want {
				t.Errorf("session %d packet %d (%s %s): stream_offset %d, expected %d",
					sess.ID, pkt.ID, pkt.Direction, pkt.TypeName, pkt.StreamOffset, want)
			}
			offsets[pkt.Direction] += int64(pkt.Length)
		}

		if !sess.EndedAt.IsZero() && sess.EndedAt.Before(sess.StartedAt) {
			t.Errorf("session %d ended before it started", sess.ID)
		}
		if sess.SSLAccepted && !sess.SSLRequested {
			t.Errorf("session %d: SSL accepted but never requested", sess.ID)
		}
	}
}

func loadGolden(t *testing.T) *SessionCapture {
	t.Helper()
	data, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden capture: %v (record one with pgwire-capture --out %s)", err, goldenPath)
	}
	var capture SessionCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatalf("parse golden capture: %v", err)
	}
	return &capture
}

func writeGolden(t *testing.T, capture *SessionCapture) {
	t.Helper()
	data, err := json.MarshalIndent(capture, "", "  ")
	if err != nil {
		t.Fatalf("marshal golden capture: %v", err)
	}
	if err := os.WriteFile(filepath.Clean(goldenPath), append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write golden capture: %v", err)
	}
}

// nonWireMessages are the packets that are not wire-protocol messages at all:
// the reply to SSLRequest/GSSENCRequest is a single raw byte with no type tag
// and no length, so pgproto.Decode has nothing to work with and their
// annotations are written by hand.
var nonWireMessages = map[string]bool{
	"SSLResponse":    true,
	"GSSENCResponse": true,
}

func isWireMessage(pkt *PacketRecord) bool {
	return !nonWireMessages[pkt.TypeName]
}

func mustJSON(v any) string {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "<unmarshalable>"
	}
	return string(data)
}
