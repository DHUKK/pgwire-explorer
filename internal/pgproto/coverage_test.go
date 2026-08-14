package pgproto

import (
	"encoding/binary"
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"testing"
)

// annotatedMessageNames returns every pgproto3 message type that annotate.go
// has an explicit case for, by parsing the file rather than by keeping a
// hand-maintained list beside it. A list would drift the moment someone adds a
// case, which is exactly the drift the coverage check exists to catch.
//
// It looks for `case *pgproto3.Foo:` (and multi-type cases like
// `case *pgproto3.Flush, *pgproto3.Sync:`) anywhere in the file.
func annotatedMessageNames() []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "annotate.go", nil, 0)
	if err != nil {
		// Reported by the caller as a test failure. Returning nil here would
		// silently pass the coverage check instead.
		panic("parse annotate.go: " + err.Error())
	}

	seen := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		clause, ok := n.(*ast.CaseClause)
		if !ok {
			return true
		}
		for _, expr := range clause.List {
			star, ok := expr.(*ast.StarExpr)
			if !ok {
				continue
			}
			sel, ok := star.X.(*ast.SelectorExpr)
			if !ok {
				continue
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "pgproto3" {
				continue
			}
			seen[sel.Sel.Name] = true
		}
		return true
	})

	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// TestAnnotatedMessageNamesFound guards the guard: if the AST walk above ever
// stops finding cases (renamed import, restructured switch), the coverage
// subtest in TestAnnotateInvariants would vacuously pass.
func TestAnnotatedMessageNamesFound(t *testing.T) {
	names := annotatedMessageNames()
	if len(names) < 40 {
		t.Fatalf("found only %d annotated message types (%v). The AST walk is probably broken", len(names), names)
	}
	t.Logf("annotate.go handles %d message types", len(names))
}

// documentedMessages is every message the protocol specification lists, taken
// from https://www.postgresql.org/docs/18/protocol-message-formats.html
//
// That page covers protocol 3.0 and 3.2 together, because the two differ only in
// the layout of BackendKeyData and CancelRequest, not in which messages exist.
//
// Hardcoded on purpose, and the one list in this file that is not derived from
// our own code. Deriving it would only ever prove that we handle what we handle.
// This is the specification's side of the comparison, so when PostgreSQL adds a
// message, editing this list is what makes the test start failing.
//
// SSLResponse and GSSENCResponse are deliberately absent: they are single reply
// bytes rather than messages, have no entry on that page, and the proxy annotates
// them by hand.
//
// AuthenticationSCMCredential is absent for a different reason. It was code 6 and
// appears in the docs up to PostgreSQL 15, but 18 dropped it, so it is no longer
// part of the specification this list tracks. It is not in unhandledMessages
// either, because that list is checked against this one. Nothing was lost: only
// pre-9.1 servers ever sent it, and the credential it asked for travelled as
// socket ancillary data on a Unix-domain socket, so the part that did the
// authenticating was never in the byte stream for a capture to show.
var documentedMessages = []string{
	"AuthenticationCleartextPassword",
	"AuthenticationGSS",
	"AuthenticationGSSContinue",
	"AuthenticationKerberosV5",
	"AuthenticationMD5Password",
	"AuthenticationOk",
	"AuthenticationSASL",
	"AuthenticationSASLContinue",
	"AuthenticationSASLFinal",
	"AuthenticationSSPI",
	"BackendKeyData",
	"Bind",
	"BindComplete",
	"CancelRequest",
	"Close",
	"CloseComplete",
	"CommandComplete",
	"CopyBothResponse",
	"CopyData",
	"CopyDone",
	"CopyFail",
	"CopyInResponse",
	"CopyOutResponse",
	"DataRow",
	"Describe",
	"EmptyQueryResponse",
	"ErrorResponse",
	"Execute",
	"Flush",
	"FunctionCall",
	"FunctionCallResponse",
	"GSSENCRequest",
	"GSSResponse",
	"NegotiateProtocolVersion",
	"NoData",
	"NoticeResponse",
	"NotificationResponse",
	"ParameterDescription",
	"ParameterStatus",
	"Parse",
	"ParseComplete",
	"PasswordMessage",
	"PortalSuspended",
	"Query",
	"ReadyForQuery",
	"RowDescription",
	"SASLInitialResponse",
	"SASLResponse",
	"SSLRequest",
	"StartupMessage",
	"Sync",
	"Terminate",
}

// unhandledMessages are documented messages this decoder does not annotate, and
// why. Each one renders as "Unknown": the type identifier, the message length,
// and the payload under a field naming the decode error.
//
// That degrades safely rather than breaking anything, because framing does not
// depend on decoding. Every frame is delimited by its own length header, so an
// unrecognised message is one we located exactly and merely cannot explain.
//
// All three are authentication requests, which is not a coincidence. Auth is the
// one part of the protocol where the server picks from a set of mechanisms, so it
// is the only place where messages accumulate and fall out of use.
var unhandledMessages = map[string]string{
	// The message formats page still lists code 2, and the message flow page says
	// of it, in full: "This is no longer supported."
	"AuthenticationKerberosV5": "the protocol docs say of it: \"This is no longer supported\"",

	// pgproto3 defines AuthTypeSSPI = 9 and then refuses it, and pgx has no SSPI
	// support to hand it to: it delegates even GSSAPI to an external provider
	// through the pgconn.GSS interface. Nothing about Go or Windows prevents it.
	"AuthenticationSSPI": "pgproto3 returns \"AuthTypeSSPI is unimplemented\". Supporting it would " +
		"also mean resolving the client's tag 'p' reply as a GSSResponse, which is where the " +
		"protocol carries SSPI data, rather than as the PasswordMessage pgproto3 falls back to",
}

// startupFormatMessages are the untagged messages, which annotate.go has no
// pgproto3 case for: they are classified and dispatched before pgproto3 is
// involved, so the AST walk above cannot see them.
//
// Discovered by asking PreStartupMessage itself rather than by repeating its
// list. Adding a new startup-format message means adding a code here too, and
// until then this test reports it as unhandled, which is the safe direction to
// fail in.
func startupFormatMessages(t *testing.T) map[string]bool {
	t.Helper()

	names := map[string]bool{}
	for _, code := range []uint32{CodeStartup, CodeStartup32, CodeCancel, CodeSSL, CodeGSSENC} {
		raw := make([]byte, 8)
		binary.BigEndian.PutUint32(raw[0:4], 8)
		binary.BigEndian.PutUint32(raw[4:8], code)

		name, _, ok := PreStartupMessage(raw)
		if !ok {
			t.Fatalf("PreStartupMessage rejected request code %d, so this test cannot tell which "+
				"untagged messages are handled", code)
		}
		names[name] = true
	}
	return names
}

// TestProtocolCoverage answers "does this decoder handle the whole protocol"
// as a test rather than as an afternoon of reading the specification.
//
// Establishing this by hand meant diffing the docs against an AST dump. Once
// that is written down, the answer stays current for free: a message added to
// the specification, a case removed from annotate.go, or one of the deliberate
// omissions quietly gaining support all show up here.
func TestProtocolCoverage(t *testing.T) {
	handled := map[string]bool{}
	for _, name := range annotatedMessageNames() {
		handled[name] = true
	}
	for name := range startupFormatMessages(t) {
		handled[name] = true
	}

	t.Run("every documented message is handled or deliberately not", func(t *testing.T) {
		for _, name := range documentedMessages {
			if handled[name] {
				continue
			}
			if _, known := unhandledMessages[name]; known {
				continue
			}
			t.Errorf("%s is in the protocol specification but annotate.go has no case for it, "+
				"and it is not listed in unhandledMessages. It would render as Unknown", name)
		}
	})

	// The reverse direction, so the omission list cannot rot. An entry that is no
	// longer documented, or one that has since been implemented, is stale.
	t.Run("the omission list stays honest", func(t *testing.T) {
		documented := map[string]bool{}
		for _, name := range documentedMessages {
			documented[name] = true
		}
		for name := range unhandledMessages {
			if !documented[name] {
				t.Errorf("unhandledMessages lists %s, which is not in documentedMessages. "+
					"Either it was dropped from the specification or the name is a typo", name)
			}
			if handled[name] {
				t.Errorf("unhandledMessages says %s is not handled, but annotate.go has a case "+
					"for it. Remove the entry", name)
			}
		}
	})

	t.Logf("%d of %d documented messages annotated, %d deliberately not",
		len(documentedMessages)-len(unhandledMessages), len(documentedMessages), len(unhandledMessages))
}
