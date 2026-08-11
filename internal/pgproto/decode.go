package pgproto

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgproto3"
)

// Decoded is the full result of interpreting one raw wire frame.
type Decoded struct {
	// TypeChar is the 1-byte type identifier, or "" for startup-format
	// messages (which have no tag) and for frames that failed to decode.
	TypeChar string
	// TypeName is the pgproto3 message type name, or "Unknown". It is never
	// empty, so no frame renders as a blank row.
	TypeName string
	// Fields is the byte-range-annotated field tree. See FieldAnnotation for
	// the invariants it satisfies.
	Fields []FieldAnnotation
	// AuthType is the numeric AuthType of a BE Authentication* message, and
	// AuthTypeKnown reports whether this frame was one. The caller must feed
	// it back in as the authType argument of subsequent ClientToServer
	// Decode calls on the same session, so an FE tag 'p' can be
	// disambiguated. See AuthTypeOf.
	AuthType      uint32
	AuthTypeKnown bool
}

// Decode interprets one complete raw wire frame.
//
// authType is the most recent BE Authentication* subtype seen on this session
// (zero if none), needed only to disambiguate the overloaded FE tag 'p'.
//
// Decode never returns an error and never panics: a frame it cannot parse
// still comes back named "Unknown" with its bytes as a single raw-payload
// annotation. That matters because the caller relays live traffic. A decoder bug
// must degrade to a bad annotation, never take down the proxy.
func Decode(dir Direction, raw []byte, authType uint32) (d Decoded) {
	defer func() {
		if r := recover(); r != nil {
			d.TypeName = "Unknown"
			d.Fields = []FieldAnnotation{{
				Name:  fmt.Sprintf("Raw Payload (decoder panic: %v)", r),
				Value: hex.EncodeToString(raw),
				Bytes: [2]int{0, max0(len(raw) - 1)},
			}}
		}
	}()

	if len(raw) == 0 {
		return Decoded{TypeName: "Unknown", Fields: nil}
	}

	// Startup-format frames carry no tag and pgproto3 will not decode them
	// from a Backend, so they are handled separately. Only a client can send
	// one.
	if name, _, ok := PreStartupMessage(raw); ok && dir == ClientToServer {
		return Decoded{TypeName: name, Fields: annotateStartupFormat(name, raw)}
	}

	if dir == ClientToServer {
		backend := pgproto3.NewBackend(bytes.NewReader(raw), nil)
		// A fresh Backend per frame keeps decoding off the relay path's
		// critical section. But tag 'p' is overloaded, shared by
		// PasswordMessage, SASLInitialResponse, SASLResponse and GSSResponse,
		// and pgproto3 resolves that overload from Backend.authType. The caller
		// tracks the real state, so we feed it in here to make a stateless
		// Backend disambiguate correctly anyway.
		_ = backend.SetAuthType(authType)
		msg, err := backend.Receive()
		if err != nil {
			return Decoded{TypeName: "Unknown", Fields: annotateUnknown(raw, err)}
		}
		return Decoded{
			TypeChar: string(raw[0]),
			TypeName: messageName(msg),
			Fields:   annotateFields(msg, raw),
		}
	}

	frontend := pgproto3.NewFrontend(bytes.NewReader(raw), nil)
	msg, err := frontend.Receive()
	if err != nil {
		return Decoded{TypeName: "Unknown", Fields: annotateUnknown(raw, err)}
	}
	d = Decoded{
		TypeChar: string(raw[0]),
		TypeName: messageName(msg),
		Fields:   annotateFields(msg, raw),
	}
	if auth, ok := msg.(pgproto3.AuthenticationResponseMessage); ok {
		d.AuthType, d.AuthTypeKnown = AuthTypeOf(auth), true
	}
	return d
}

// messageName renders the pgproto3 message type as its bare Go type name,
// e.g. "*pgproto3.RowDescription" -> "RowDescription".
func messageName(msg pgproto3.Message) string {
	return strings.TrimPrefix(fmt.Sprintf("%T", msg), "*pgproto3.")
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}
