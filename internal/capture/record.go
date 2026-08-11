package capture

import (
	"encoding/hex"
	"time"

	"pgwire-explorer/internal/pgproto"
)

// Record decodes raw into a PacketRecord and appends it to the session.
//
// offset is the byte offset of raw within its own direction's stream, and
// startTime is the session's start (so timestamps are relative to the session,
// not to the capture as a whole).
//
// Decoding always happens after the bytes have already been forwarded, so it
// adds no latency to the relayed connection, and it cannot fail: an
// unparseable frame is recorded as "Unknown" with its raw bytes (see
// pgproto.Decode).
func (s *Session) Record(dir pgproto.Direction, raw []byte, offset int64, startTime time.Time) {
	elapsed := float64(time.Since(startTime).Microseconds()) / 1000.0

	d := pgproto.Decode(dir, raw, s.getAuthType())
	if d.AuthTypeKnown {
		// Remembered for the next FE tag 'p' on this session.
		s.setAuthType(d.AuthType)
	}

	s.AddPacket(PacketRecord{
		Direction:    string(dir),
		TimestampMs:  elapsed,
		StreamOffset: offset,
		Length:       len(raw),
		RawHex:       hex.EncodeToString(raw),
		TypeChar:     d.TypeChar,
		TypeName:     d.TypeName,
		Fields:       d.Fields,
	})
}

// RecordRaw appends a packet whose type name and fields the caller supplies,
// for bytes that are not a wire-protocol message and so have nothing
// pgproto.Decode could make sense of. The single-byte reply to
// SSLRequest/GSSENCRequest is the only case.
func (s *Session) RecordRaw(dir pgproto.Direction, raw []byte, offset int64, startTime time.Time, typeChar, typeName string, fields []pgproto.FieldAnnotation) {
	s.AddPacket(PacketRecord{
		Direction:    string(dir),
		TimestampMs:  float64(time.Since(startTime).Microseconds()) / 1000.0,
		StreamOffset: offset,
		Length:       len(raw),
		RawHex:       hex.EncodeToString(raw),
		TypeChar:     typeChar,
		TypeName:     typeName,
		Fields:       fields,
	})
}
