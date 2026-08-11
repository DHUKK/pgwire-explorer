package pgproto

import (
	"encoding/binary"
	"io"
)

// --- Wire framing ---

// Direction identifies which half of the conversation a frame belongs to.
// Framing and decoding both depend on it: the frontend and backend halves of
// the v3 protocol reuse the same tag bytes for different messages.
type Direction string

const (
	ClientToServer Direction = "C2S"
	ServerToClient Direction = "S2C"
)

// ReadRawFrame reads exactly one wire message from r and returns its complete
// bytes, header included.
//
// startupDone is read *and written*: the first frame a client sends has no
// 1-byte type identifier (it begins directly with an Int32 length), so the
// caller starts a client stream with false and this function flips it to true
// once that frame is consumed. A denied SSLRequest is the exception, because the
// client's next frame is still in startup format, so the proxy resets the flag
// itself in that case. Server streams are always tagged, so they start with
// true.
func ReadRawFrame(r io.Reader, startupDone *bool) ([]byte, error) {
	// Startup messages lack the 1-byte type identifier, and start directly
	// with an Int32 length that INCLUDES itself.
	if !*startupDone {
		var lenBuf [4]byte
		if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
			return nil, err
		}
		msgLen := binary.BigEndian.Uint32(lenBuf[:])
		if msgLen < 4 || msgLen > MaxFrameLen {
			return nil, ErrFrameLen
		}

		raw := make([]byte, msgLen)
		copy(raw[0:4], lenBuf[:])
		if _, err := io.ReadFull(r, raw[4:]); err != nil {
			return nil, err
		}
		*startupDone = true
		return raw, nil
	}

	// Standard wire v3 frame: [1-byte Type][4-byte Length]. Length covers itself
	// and the payload, but NOT the type byte, hence the extra 1 in totalLen.
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}

	msgLen := binary.BigEndian.Uint32(hdr[1:5])
	if msgLen < 4 || msgLen > MaxFrameLen {
		return nil, ErrFrameLen
	}
	totalLen := 1 + int(msgLen)

	raw := make([]byte, totalLen)
	copy(raw[0:5], hdr[:])
	if _, err := io.ReadFull(r, raw[5:]); err != nil {
		return nil, err
	}

	return raw, nil
}

// MaxFrameLen caps how much a single frame may claim, so a desynced or
// hostile stream cannot make the proxy allocate unbounded memory from a
// 4-byte length field. Postgres itself has no such limit, but real messages
// (including COPY data and large bytea values) stay far below this.
const MaxFrameLen = 64 << 20 // 64 MiB

// ErrFrameLen reports a length header that cannot describe a real frame:
// below the 4 bytes the length field itself occupies, or above MaxFrameLen.
var ErrFrameLen = errFrameLen{}

type errFrameLen struct{}

func (errFrameLen) Error() string {
	return "pgproto: frame length out of range (stream desynced?)"
}

// Int32 request codes that occupy the version field of a startup-format
// message (Int32 length, Int32 code, with no 1-byte type identifier).
//
// CodeStartup and CodeStartup32 are both StartupMessage: the low 16 bits are
// the minor protocol version (0 for 3.0, 2 for 3.2, introduced in PostgreSQL
// 18), and the high 16 bits (3) identify the major version. libpq 18 still
// requests 3.0 by default and only asks for 3.2 when a connection option
// requires it or max_protocol_version is set explicitly, so both codes are
// real traffic, not just a future possibility.
//
// PreStartupMessage matches these two exact values rather than masking the
// high 16 bits and accepting any 3.x. Two reasons: pgx's own pgproto3.
// StartupMessage.Decode (which the proxy's real connections rely on) only
// ever accepts exactly 196608 or 196610 and errors on anything else, so a
// real capture can never contain a third minor version. Also,
// annotateStartupFormat's byte layout is verified against 3.0 and 3.2
// specifically, not against a hypothetical future minor version whose
// parameter format could change again the way 3.2 changed the secret key.
// Masking would let a stray 4-byte value that happens to start with 0x0003
// be classified and annotated as a StartupMessage with no such assurance.
const (
	CodeStartup   = 196608 // protocol 3.0
	CodeStartup32 = 196610 // protocol 3.2 (PostgreSQL 18+)
	CodeCancel    = 80877102
	CodeSSL       = 80877103
	CodeGSSENC    = 80877104
)

// PreStartupMessage classifies a startup-format (untagged) message. deny reports
// whether the proxy must answer it itself rather than forward it. ok reports
// whether raw is a startup-format message at all.
func PreStartupMessage(raw []byte) (name string, deny bool, ok bool) {
	if len(raw) < 8 || int(binary.BigEndian.Uint32(raw[0:4])) != len(raw) {
		return "", false, false
	}
	switch binary.BigEndian.Uint32(raw[4:8]) {
	case CodeSSL:
		return "SSLRequest", true, true
	case CodeGSSENC:
		return "GSSENCRequest", true, true
	case CodeCancel:
		// Forwarded as-is: the client quotes the *real* backend's PID and
		// secret key, since BackendKeyData passes through us unmodified.
		return "CancelRequest", false, true
	case CodeStartup, CodeStartup32:
		return "StartupMessage", false, true
	}
	return "", false, false
}
