package capture

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"pgwire-explorer/internal/pgproto"
)

const scenarioDir = "../../site/public/scenarios"

// scenarioExpectations names the message types each shipped scenario exists to
// show. The site presents these as teaching examples, so a scenario that
// silently stopped containing its own subject matter would be worse than a
// missing one. Someone would click "SCRAM authentication" and be shown a plain
// AuthenticationOk.
//
// Regenerate the scenarios with scripts/generate-scenarios.sh.
var scenarioExpectations = map[string][]string{
	"scram-auth": {
		"SSLRequest", "SSLResponse", "StartupMessage",
		"AuthenticationSASL", "SASLInitialResponse",
		"AuthenticationSASLContinue", "SASLResponse",
		"AuthenticationSASLFinal", "AuthenticationOk",
	},
	"md5-auth": {
		"StartupMessage", "AuthenticationMD5Password", "PasswordMessage", "AuthenticationOk",
	},
	"cleartext-auth": {
		"StartupMessage", "AuthenticationCleartextPassword", "PasswordMessage", "AuthenticationOk",
	},
	// The absence is the subject here, so there is nothing to name beyond the two
	// messages the handshake is reduced to. What actually holds this example is
	// authScenarios below, which is what forbids a credential message.
	"trust-auth": {
		"SSLRequest", "SSLResponse", "StartupMessage", "AuthenticationOk",
	},
	// Two query cycles and nothing else, so NoticeResponse is no longer among
	// them. It used to arrive from a DO block that raised one, which was a third
	// cycle this example does not claim to show.
	"simple-query": {
		"Query", "RowDescription", "DataRow", "CommandComplete", "ReadyForQuery",
		"ErrorResponse", "Terminate",
	},
	"extended-query": {
		"Parse", "Bind", "Describe", "Execute", "Sync",
		"ParseComplete", "ParameterDescription", "BindComplete", "RowDescription", "DataRow",
	},
	"copy-in": {
		"CopyInResponse", "CopyData", "CopyDone", "CommandComplete",
	},
	"error-response": {
		"ErrorResponse", "Sync", "ReadyForQuery",
	},
	"notify": {
		"NotificationResponse", "Query", "CommandComplete",
	},
	"cancel-request": {
		"Query", "CancelRequest", "ErrorResponse",
	},
	"replication-physical": {
		"Query", "CopyBothResponse", "CopyData", "CopyDone", "CommandComplete", "ReadyForQuery",
		"Terminate",
	},
	"replication-logical": {
		"Query", "CopyBothResponse", "CopyData", "CopyDone", "CommandComplete", "ReadyForQuery",
		"Terminate",
	},
	// Recorded under trust like everything outside authScenarios, so the SASL
	// exchange it used to contain is gone. Version negotiation is the subject and
	// an authentication method in front of it was only ever a distraction.
	"protocol-32-downgrade": {
		"StartupMessage", "NegotiateProtocolVersion",
		"AuthenticationOk", "BackendKeyData", "ReadyForQuery", "Terminate",
	},
}

// authScenarios are the examples that exist to show an authentication method,
// and so the only ones allowed to contain a credential exchange. Every other
// scenario is recorded under trust (see scripts/generate-scenarios.sh), which
// cuts its preamble down to StartupMessage and AuthenticationOk.
//
// Worth enforcing rather than leaving to the script, for two reasons. The
// highlight ranges in site/src/lib/scenarios.ts are literal packet IDs, so five
// messages of SASL reappearing in front of every capture would silently move all
// of them. And a capture recorded against a method that hashes a password
// carries a salted hash of it, which is not something to commit by accident.
var authScenarios = map[string]bool{
	"scram-auth":     true,
	"md5-auth":       true,
	"cleartext-auth": true,
}

// isCredentialMessage reports whether typeName only ever appears because the
// server asked for a credential. AuthenticationOk is deliberately not one of
// them: every successful session ends its handshake with it, trust included.
func isCredentialMessage(typeName string) bool {
	switch typeName {
	case "AuthenticationSASL", "AuthenticationSASLContinue", "AuthenticationSASLFinal",
		"SASLInitialResponse", "SASLResponse",
		"AuthenticationMD5Password", "AuthenticationCleartextPassword", "PasswordMessage",
		"AuthenticationGSS", "AuthenticationGSSContinue", "GSSResponse":
		return true
	}
	return false
}

// secretKeyLengthExpectations names the number of bytes BackendKeyData's
// "Secret Key" annotation must cover. protocol-32-downgrade asks for protocol
// 3.2 and is negotiated down to 3.0, so its cancel key is the old fixed
// 4-byte uint32 rather than 3.2's Byte(n). A change that left the connection
// on 3.2 would still pass scenarioExpectations above and fail here.
var secretKeyLengthExpectations = map[string]int{
	"protocol-32-downgrade": 4,
}

// findSecretKeyLength returns the byte length of the first "Secret Key"
// annotation found under a BackendKeyData packet's fields, or -1 if none was
// found.
func findSecretKeyLength(fields []pgproto.FieldAnnotation) int {
	for _, f := range fields {
		if f.Name == "Secret Key" {
			return f.Bytes[1] - f.Bytes[0] + 1
		}
		if n := findSecretKeyLength(f.Children); n >= 0 {
			return n
		}
	}
	return -1
}

// replicationScenarios exist to show a slot being set up and one write being
// replicated, nothing else. Their scaffolding (creating the table or
// publication) has to happen on cmd/pgwire-demo's --setup-dsn, a connection
// straight to Postgres that never touches the proxy. These two checks pin
// that down: a scaffolding CommandComplete or an ErrorResponse (the shape a
// leftover DROP_REPLICATION_SLOT used to take when there was nothing to
// drop) in either capture means scaffolding has leaked back through the
// proxy and the capture is noisy again.
var replicationScenarios = map[string]bool{
	"replication-physical": true,
	"replication-logical":  true,
}

// commandTagIsScaffoldingDDL reports whether tag is the CommandComplete tag
// for a CREATE or DROP of a table or publication, the kind of scaffolding
// statement that belongs on the direct connection, not the captured one.
func commandTagIsScaffoldingDDL(tag string) bool {
	upper := strings.ToUpper(tag)
	for _, verb := range []string{"CREATE TABLE", "DROP TABLE", "CREATE PUBLICATION", "DROP PUBLICATION"} {
		if strings.HasPrefix(upper, verb) {
			return true
		}
	}
	return false
}

// findCommandTag returns the value of a CommandComplete's "Command Tag"
// annotation, or "", false if none was found.
func findCommandTag(fields []pgproto.FieldAnnotation) (string, bool) {
	for _, f := range fields {
		if f.Name == "Command Tag" {
			if s, ok := f.Value.(string); ok {
				return s, true
			}
		}
		if s, ok := findCommandTag(f.Children); ok {
			return s, true
		}
	}
	return "", false
}

// replicationSubtypeExpectations names the streaming-replication submessages
// (see internal/pgproto's annotateCopyData) each replication scenario exists
// to show. TypeName alone can't tell these apart: every one of them decodes
// as plain CopyData, so what actually distinguishes the scenario is which
// "Subtype" field values appear inside those CopyData packets' annotations.
var replicationSubtypeExpectations = map[string][]string{
	"replication-physical": {
		"XLogData (w)",
		"Standby status update (r)",
	},
	"replication-logical": {
		"XLogData (w)",
		"Standby status update (r)",
	},
}

// annotationValueExpectations names annotation values a scenario exists to
// show, for the cases where a message type cannot stand in for one.
//
// error-response is the whole of it. Its three ErrorResponse packets are
// indistinguishable by TypeName, and the point of its second half is that
// ReadyForQuery reports Failed rather than Idle: a regeneration that lost the
// BEGIN, or one where the aborted transaction stopped rejecting the statement
// after it, would still contain every message type the scenario advertises.
var annotationValueExpectations = map[string][]string{
	// The whole argument for the other three methods is that this one puts the
	// password on the wire, so the recording has to actually show it. This is the
	// throwaway password in scripts/generate-scenarios.sh, in a capture of a
	// container that no longer exists.
	"cleartext-auth": {"wire_demo_password"},
	"error-response": {
		// The extended-protocol failure.
		"42P01 (undefined_table)",
		// The failure inside the transaction, then the statement the aborted
		// transaction refuses to run, then the status that refusal depends on.
		"23505 (unique_violation)",
		"25P02 (in_failed_sql_transaction)",
		"Failed",
	},
}

// collectStringValues walks a field tree collecting every string annotation
// value, which is what annotationValueExpectations is matched against.
func collectStringValues(fields []pgproto.FieldAnnotation, into map[string]bool) {
	for _, f := range fields {
		if s, ok := f.Value.(string); ok {
			into[s] = true
		}
		collectStringValues(f.Children, into)
	}
}

// collectSubtypeValues walks a field tree collecting every value of a field
// named "Subtype", which is how annotateCopyData in internal/pgproto marks
// which replication submessage a CopyData payload decoded as.
func collectSubtypeValues(fields []pgproto.FieldAnnotation, into map[string]bool) {
	for _, f := range fields {
		if f.Name == "Subtype" {
			if s, ok := f.Value.(string); ok {
				into[s] = true
			}
		}
		collectSubtypeValues(f.Children, into)
	}
}

// TestScenarios validates every capture the site ships. These files are the
// product's content, not test fixtures: they are what a visitor sees before
// they ever record anything of their own, so they get the same scrutiny as the
// golden capture.
func TestScenarios(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join(scenarioDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatalf("no scenarios in %s (run scripts/generate-scenarios.sh)", scenarioDir)
	}

	found := map[string]bool{}

	for _, path := range paths {
		name := filepath.Base(path)
		name = name[:len(name)-len(".json")]
		found[name] = true

		t.Run(name, func(t *testing.T) {
			capture := loadCapture(t, path)

			if capture.Version != SchemaVersion {
				t.Errorf("schema %q, current is %q. Regenerate the scenarios", capture.Version, SchemaVersion)
			}
			if len(capture.Sessions) == 0 {
				t.Fatal("no sessions")
			}

			seen := map[string]bool{}
			seenSubtypes := map[string]bool{}
			seenValues := map[string]bool{}
			secretKeyLen := -1
			var authType uint32
			for _, sess := range capture.Sessions {
				// Auth state is per-connection, so it resets with each session.
				authType = 0
				for i := range sess.Packets {
					pkt := &sess.Packets[i]
					seen[pkt.TypeName] = true

					if pkt.TypeName == "Unknown" {
						t.Errorf("session %d packet %d did not decode: %s", sess.ID, pkt.ID, pkt.RawHex)
					}

					if !authScenarios[name] && isCredentialMessage(pkt.TypeName) {
						t.Errorf("session %d packet %d: %s is recorded under trust and must not contain "+
							"a credential message, found %s. Re-record it with scripts/generate-scenarios.sh",
							sess.ID, pkt.ID, name, pkt.TypeName)
					}

					if replicationScenarios[name] {
						if pkt.TypeName == "ErrorResponse" {
							t.Errorf("session %d packet %d: %s must not contain an ErrorResponse, "+
								"which is the shape scaffolding noise takes when it leaks through the proxy",
								sess.ID, pkt.ID, name)
						}
						if pkt.TypeName == "CommandComplete" {
							if tag, ok := findCommandTag(pkt.Fields); ok && commandTagIsScaffoldingDDL(tag) {
								t.Errorf("session %d packet %d: %s command tag %q looks like scaffolding DDL "+
									"that leaked through the proxy instead of running on --setup-dsn",
									sess.ID, pkt.ID, name, tag)
							}
						}
					}

					raw, err := hex.DecodeString(pkt.RawHex)
					if err != nil {
						t.Fatalf("session %d packet %d: bad raw_hex: %v", sess.ID, pkt.ID, err)
					}
					if len(raw) != pkt.Length {
						t.Errorf("session %d packet %d: raw_hex is %d bytes, length says %d",
							sess.ID, pkt.ID, len(raw), pkt.Length)
					}

					// Not a wire message (see nonWireMessages): only has to be
					// annotated, since there is nothing to re-decode.
					if !isWireMessage(pkt) {
						if len(pkt.Fields) == 0 {
							t.Errorf("session %d packet %d: packet has no fields", sess.ID, pkt.ID)
						}
						continue
					}

					d := pgproto.Decode(pgproto.Direction(pkt.Direction), raw, authType)
					if d.AuthTypeKnown {
						authType = d.AuthType
					}
					if d.TypeName != pkt.TypeName {
						t.Errorf("session %d packet %d: stored as %q but decodes as %q",
							sess.ID, pkt.ID, pkt.TypeName, d.TypeName)
					}
					// The scenarios are shipped assets: if the decoder has moved
					// on, they are stale and the UI would show annotations that no
					// longer match what the tool produces.
					if got, want := mustJSON(d.Fields), mustJSON(pkt.Fields); got != want {
						t.Errorf("session %d packet %d (%s): annotations are stale. Regenerate the scenarios\n got: %s\nwant: %s",
							sess.ID, pkt.ID, pkt.TypeName, got, want)
					}

					checkFieldRanges(t, pkt, pkt.Fields, 0, pkt.Length-1)
					collectSubtypeValues(pkt.Fields, seenSubtypes)
					collectStringValues(pkt.Fields, seenValues)
					if pkt.TypeName == "BackendKeyData" {
						secretKeyLen = findSecretKeyLength(pkt.Fields)
					}
				}
			}

			want, ok := scenarioExpectations[name]
			if !ok {
				t.Fatalf("scenario %q has no entry in scenarioExpectations. Add one saying what it teaches", name)
			}
			for _, typeName := range want {
				if !seen[typeName] {
					t.Errorf("scenario no longer contains a %s packet, which is the point of it", typeName)
				}
			}
			for _, subtype := range replicationSubtypeExpectations[name] {
				if !seenSubtypes[subtype] {
					t.Errorf("scenario no longer contains a CopyData payload decoded as %q, which is the point of it", subtype)
				}
			}
			for _, value := range annotationValueExpectations[name] {
				if !seenValues[value] {
					t.Errorf("scenario no longer contains an annotation with the value %q, which is the point of it", value)
				}
			}
			if wantLen, ok := secretKeyLengthExpectations[name]; ok {
				if secretKeyLen < 0 {
					t.Errorf("scenario has no BackendKeyData with a Secret Key annotation to check")
				} else if secretKeyLen != wantLen {
					t.Errorf("BackendKeyData secret key is %d bytes, want %d", secretKeyLen, wantLen)
				}
			}
		})
	}

	// The other direction: an expectation with no file means a scenario the
	// site's manifest may still reference.
	var missing []string
	for name := range scenarioExpectations {
		if !found[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	for _, name := range missing {
		t.Errorf("expected scenario %q has no capture file in %s", name, scenarioDir)
	}
}

// checkFieldRanges asserts the byte ranges tile [lo, hi] exactly and recurses
// into children. This is the invariant the UI's hex-dump highlighting depends
// on. internal/pgproto tests it against freshly decoded messages, and this
// checks the shipped files really have it.
func checkFieldRanges(t *testing.T, pkt *PacketRecord, fields []pgproto.FieldAnnotation, lo, hi int) {
	t.Helper()
	if len(fields) == 0 {
		t.Errorf("packet %d (%s): no field annotations", pkt.ID, pkt.TypeName)
		return
	}

	want := lo
	for _, f := range fields {
		start, end := f.Bytes[0], f.Bytes[1]

		if end == start-1 { // legitimately empty value
			continue
		}
		if start < lo || end > hi {
			t.Errorf("packet %d (%s) field %q: range [%d,%d] escapes [%d,%d]",
				pkt.ID, pkt.TypeName, f.Name, start, end, lo, hi)
			continue
		}
		if start != want {
			t.Errorf("packet %d (%s) field %q: range starts at %d, expected %d (gap or overlap)",
				pkt.ID, pkt.TypeName, f.Name, start, want)
		}
		want = end + 1

		if len(f.Children) > 0 {
			checkFieldRanges(t, pkt, f.Children, start, end)
		}
	}
	if want != hi+1 {
		t.Errorf("packet %d (%s): %d trailing byte(s) unexplained", pkt.ID, pkt.TypeName, hi+1-want)
	}
}

func loadCapture(t *testing.T, path string) *SessionCapture {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var capture SessionCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &capture
}
