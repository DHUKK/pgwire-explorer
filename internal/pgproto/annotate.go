package pgproto

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgproto3"
)

// --- Field annotation ---
//
// pgproto3 is the only decoder: every value below comes from a typed
// pgproto3 struct (msg). Byte offsets are computed alongside by hand,
// walking `raw` with a single local position variable per decoder function,
// exactly mirroring the order pgproto3's own Decode methods read fields in.
// This file intentionally does not build a generic cursor abstraction. Each
// function is a straight-line sequence of "read a value, know its width,
// emit a FieldAnnotation, advance pos" because getting the widths right by
// hand is the whole point of a teaching tool.

// FieldAnnotation maps a decoded value back to the exact bytes that produced
// it. Bytes is an INCLUSIVE [start, end] byte range relative to the start of
// the packet (the tag byte, if any, is byte 0). Nested/repeated structures
// (RowDescription columns, DataRow columns, Bind parameters, StartupMessage
// parameters, ErrorResponse fields, ...) are represented as Children rather
// than being flattened, so the UI can render a readable tree. The parent's
// Bytes range spans the whole group.
//
// Two invariants hold for every packet and are enforced by TestByteRanges:
// the top-level Bytes ranges tile the packet exactly (no gaps, no overlaps,
// nothing out of range), and every child's range lies within its parent's.
// The UI relies on both to wire the field tree to the hex dump.
type FieldAnnotation struct {
	Name     string            `json:"name"`
	Value    interface{}       `json:"value,omitempty"`
	Bytes    [2]int            `json:"bytes"`
	Children []FieldAnnotation `json:"children,omitempty"`
}

// --- small helpers for emitting a FieldAnnotation and advancing pos ---

func fByteChar(raw []byte, pos int, name string) (FieldAnnotation, int) {
	return FieldAnnotation{Name: name, Value: string(raw[pos]), Bytes: [2]int{pos, pos}}, pos + 1
}

func fUint16(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := binary.BigEndian.Uint16(raw[pos : pos+2])
	return FieldAnnotation{Name: name, Value: v, Bytes: [2]int{pos, pos + 1}}, pos + 2
}

func fInt16(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := int16(binary.BigEndian.Uint16(raw[pos : pos+2]))
	return FieldAnnotation{Name: name, Value: v, Bytes: [2]int{pos, pos + 1}}, pos + 2
}

func fUint32(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := binary.BigEndian.Uint32(raw[pos : pos+4])
	return FieldAnnotation{Name: name, Value: v, Bytes: [2]int{pos, pos + 3}}, pos + 4
}

func fInt32(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := int32(binary.BigEndian.Uint32(raw[pos : pos+4]))
	return FieldAnnotation{Name: name, Value: v, Bytes: [2]int{pos, pos + 3}}, pos + 4
}

// fCString reads a NUL-terminated string starting at pos. The emitted byte
// range INCLUDES the terminating NUL, the same convention Query and
// CommandComplete use.
func fCString(raw []byte, pos int, name string) (FieldAnnotation, int) {
	idx := bytes.IndexByte(raw[pos:], 0)
	if idx < 0 {
		// Malformed (no NUL found): consume to the end rather than panic.
		return FieldAnnotation{Name: name + " (unterminated)", Value: string(raw[pos:]), Bytes: [2]int{pos, len(raw) - 1}}, len(raw)
	}
	end := pos + idx
	return FieldAnnotation{Name: name, Value: string(raw[pos:end]), Bytes: [2]int{pos, end}}, end + 1
}

// fRawBytes emits the remainder [pos, end] as one field, formatted as text if
// printable-ish, hex otherwise (used for opaque SASL/GSS/CopyData payloads).
func fRawBytes(raw []byte, pos, end int, name string) FieldAnnotation {
	if end < pos {
		return FieldAnnotation{Name: name, Value: "", Bytes: [2]int{pos, pos - 1}}
	}
	data := raw[pos : end+1]
	return FieldAnnotation{Name: name, Value: displayBytes(data), Bytes: [2]int{pos, end}}
}

// fCStringRest emits [pos, len(raw)-1] as one field for a payload that is a
// single NUL-terminated string running to the end of the message (Query's SQL,
// CommandComplete's tag, PasswordMessage's password).
//
// It exists because fRawBytes would hex-encode these: the value ends in the
// C-string terminator, and displayBytes treats a trailing 0x00 as a sign the
// payload is binary, which would render every SQL string as hex. The byte
// range still covers the terminator, which is part of the message, but the
// displayed value does not include it.
func fCStringRest(raw []byte, pos int, name string) FieldAnnotation {
	end := len(raw) - 1
	if end < pos {
		return FieldAnnotation{Name: name, Value: "", Bytes: [2]int{pos, pos - 1}}
	}
	text := raw[pos:]
	if text[len(text)-1] == 0 {
		text = text[:len(text)-1]
	}
	return FieldAnnotation{Name: name, Value: displayBytes(text), Bytes: [2]int{pos, end}}
}

// displayBytes renders a payload as text when it really is text, and as hex
// otherwise. Used for opaque fields: SASL/GSS blobs, COPY data, MD5 salts, and
// binary-format column values.
//
// The UTF-8 check is not cosmetic. It is what keeps the capture lossless. A
// value ends up in JSON, and json.Marshal replaces invalid UTF-8 with U+FFFD.
// Treating an arbitrary byte >= 0x20 as printable would let a random MD5 salt
// be written out as replacement characters that could never be read back.
// Anything that is not valid, non-control UTF-8 becomes hex instead, which
// round-trips exactly.
func displayBytes(data []byte) string {
	if !utf8.Valid(data) {
		return hex.EncodeToString(data)
	}
	for _, r := range string(data) {
		// Control characters other than the usual whitespace mean this is a
		// binary payload that merely happens to be valid UTF-8.
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
			return hex.EncodeToString(data)
		}
		if r == utf8.RuneError {
			return hex.EncodeToString(data)
		}
	}
	return string(data)
}

// fLengthPrefixedOrNull emits the classic Postgres "Int32 length, then that
// many bytes, or -1 meaning NULL with no bytes at all" pattern used by Bind
// parameters, DataRow columns, and FunctionCall arguments/results.
func fLengthPrefixedOrNull(raw []byte, pos int, lengthName, dataName string) (FieldAnnotation, int) {
	length, next := fInt32(raw, pos, lengthName)
	fields := []FieldAnnotation{length}
	groupStart := pos
	if int32v, ok := length.Value.(int32); ok && int32v == -1 {
		// -1 is the wire-level sentinel for NULL: no data bytes follow.
		return FieldAnnotation{Name: dataName + " (NULL)", Bytes: [2]int{groupStart, next - 1}, Children: fields}, next
	}
	n := int(length.Value.(int32))
	dataField := fRawBytes(raw, next, next+n-1, dataName)
	fields = append(fields, dataField)
	end := next + n - 1
	return FieldAnnotation{Name: dataName, Bytes: [2]int{groupStart, end}, Children: fields}, next + n
}

// protocolVersionString renders a protocol version code as its major and minor
// parts with the raw number beside it, so 196608 reads as "3.0 (196608)". The
// high 16 bits are the major version and the low 16 bits the minor.
func protocolVersionString(v uint32) string {
	return fmt.Sprintf("%d.%d (%d)", v>>16, v&0xffff, v)
}

// --- pre-startup (untagged) messages ---

func annotateStartupFormat(name string, raw []byte) []FieldAnnotation {
	// For every startup-format message except StartupMessage itself, this
	// Int32 is a request code (80877102/80877103/80877104), chosen to be
	// unmistakable for a protocol version. For StartupMessage it IS the
	// protocol version: high 16 bits the major version (always 3), low 16
	// bits the minor version (0 for 3.0, 2 for 3.2, added in PostgreSQL 18
	// for the variable-length BackendKeyData/CancelRequest secret key and
	// the NegotiateProtocolVersion _pq_. option negotiation).
	codeName := "Request Code"
	codeValue := binary.BigEndian.Uint32(raw[4:8])
	var codeDisplay interface{} = codeValue
	if name == "StartupMessage" {
		codeName = "Protocol Version"
		codeDisplay = protocolVersionString(codeValue)
	}
	fields := []FieldAnnotation{
		{Name: "Message Length", Value: binary.BigEndian.Uint32(raw[0:4]), Bytes: [2]int{0, 3}},
		{Name: codeName, Value: codeDisplay, Bytes: [2]int{4, 7}},
	}
	pos := 8

	switch name {
	case "CancelRequest":
		if len(raw) < 12 {
			return append(fields, fRawBytes(raw, pos, len(raw)-1, "Truncated payload"))
		}
		var f FieldAnnotation
		f, pos = fUint32(raw, pos, "Backend PID")
		fields = append(fields, f)
		// Before protocol 3.2 the secret key was always exactly 4 bytes (a
		// uint32). 3.2 made it Byte(n), 4 to 256 bytes, extending to the end
		// of the message. pgproto3 always models it as []byte, so both
		// lengths are legal on the wire. A 4-byte key still renders as a
		// number, matching pre-3.2 captures. Anything else (a real 3.2 key,
		// or truncated/fuzzed input) renders as raw bytes.
		if len(raw)-pos == 4 {
			f, pos = fUint32(raw, pos, "Secret Key")
			fields = append(fields, f)
		} else if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "Secret Key"))
			pos = len(raw)
		}

	case "StartupMessage":
		if pos >= len(raw) {
			break
		}
		var params []FieldAnnotation
		groupStart := pos
		for pos < len(raw)-1 {
			var keyField, valField FieldAnnotation
			pairStart := pos
			keyField, pos = fCString(raw, pos, "Key")
			if pos > len(raw) {
				break
			}
			valField, pos = fCString(raw, pos, "Value")
			params = append(params, FieldAnnotation{
				Name:     fmt.Sprintf("%v = %v", keyField.Value, valField.Value),
				Bytes:    [2]int{pairStart, pos - 1},
				Children: []FieldAnnotation{keyField, valField},
			})
		}
		if len(params) > 0 {
			fields = append(fields, FieldAnnotation{
				Name: "Parameters", Bytes: [2]int{groupStart, pos - 1}, Children: params,
			})
		}
		// Final NUL terminating the parameter list.
		if pos < len(raw) {
			fields = append(fields, FieldAnnotation{Name: "Parameter List Terminator", Value: 0, Bytes: [2]int{pos, pos}})
			pos++
		}

	case "SSLRequest", "GSSENCRequest":
		// No payload beyond the 8-byte header.
	}

	if pos < len(raw) {
		fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "Unparsed trailing bytes"))
	}
	return fields
}

// annotateUnknown handles two distinct failure modes uniformly: a tag
// pgproto3 doesn't recognize at all, and a recognized tag whose body it
// couldn't decode (truncated/malformed). Either way we degrade gracefully:
// no panic, and every byte still gets covered by exactly one field so the
// contiguity invariant holds even for garbage input.
func annotateUnknown(raw []byte, err error) []FieldAnnotation {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) >= 5 {
		fields := []FieldAnnotation{
			{Name: "Type Identifier", Value: string(raw[0]), Bytes: [2]int{0, 0}},
			{Name: "Message Length", Value: binary.BigEndian.Uint32(raw[1:5]), Bytes: [2]int{1, 4}},
		}
		if len(raw) > 5 {
			fields = append(fields, fRawBytes(raw, 5, len(raw)-1, fmt.Sprintf("Raw Payload (decode error: %v)", err)))
		}
		return fields
	}
	return []FieldAnnotation{fRawBytes(raw, 0, len(raw)-1, fmt.Sprintf("Raw Payload (decode error: %v)", err))}
}

// AuthTypeOf extracts the numeric AuthType a BE Authentication* message
// carries, so the session can remember it for disambiguating the next FE 'p'
// message. PasswordMessage, SASLInitialResponse, SASLResponse and GSSResponse
// all share that tag, and the meaning is only recoverable from this preceding
// state, exactly as pgproto3.Backend.SetAuthType documents.
func AuthTypeOf(msg pgproto3.AuthenticationResponseMessage) uint32 {
	switch msg.(type) {
	case *pgproto3.AuthenticationOk:
		return pgproto3.AuthTypeOk
	case *pgproto3.AuthenticationCleartextPassword:
		return pgproto3.AuthTypeCleartextPassword
	case *pgproto3.AuthenticationMD5Password:
		return pgproto3.AuthTypeMD5Password
	case *pgproto3.AuthenticationGSS:
		return pgproto3.AuthTypeGSS
	case *pgproto3.AuthenticationGSSContinue:
		return pgproto3.AuthTypeGSSCont
	case *pgproto3.AuthenticationSASL:
		return pgproto3.AuthTypeSASL
	case *pgproto3.AuthenticationSASLContinue:
		return pgproto3.AuthTypeSASLContinue
	case *pgproto3.AuthenticationSASLFinal:
		return pgproto3.AuthTypeSASLFinal
	}
	return pgproto3.AuthTypeOk
}

var errorFieldMeaning = map[byte]string{
	'S': "Severity",
	'V': "Severity (unlocalized)",
	'C': "SQLSTATE Code",
	'M': "Message",
	'D': "Detail",
	'H': "Hint",
	'P': "Position",
	'p': "Internal Position",
	'q': "Internal Query",
	'W': "Where",
	's': "Schema Name",
	't': "Table Name",
	'c': "Column Name",
	'd': "Data Type Name",
	'n': "Constraint Name",
	'F': "File",
	'L': "Line",
	'R': "Routine",
}

// annotateErrorOrNotice walks the repeated (fieldCode byte, CString value)
// sequence shared by ErrorResponse and NoticeResponse, expanding each field
// code to its documented meaning, and returns the fields plus the position
// just past the sequence's terminating NUL.
func annotateErrorOrNotice(raw []byte, pos int) ([]FieldAnnotation, int) {
	groupStart := pos
	var children []FieldAnnotation
	for pos < len(raw) && raw[pos] != 0 {
		codeStart := pos
		code := raw[pos]
		pos++
		var valField FieldAnnotation
		valField, pos = fCString(raw, pos, "Value")
		meaning, known := errorFieldMeaning[code]
		if !known {
			meaning = "Unknown field"
		}

		// The SQLSTATE is the one field designed to be read by a machine, so it
		// is decoded rather than left as five digits to look up. See
		// SQLStateName.
		display := valField.Value
		if code == 'C' {
			if text, ok := valField.Value.(string); ok {
				if name := SQLStateName(text); name != "" {
					display = fmt.Sprintf("%s (%s)", text, name)
				}
			}
		}

		children = append(children, FieldAnnotation{
			Name:     fmt.Sprintf("%s (%c)", meaning, code),
			Value:    display,
			Bytes:    [2]int{codeStart, pos - 1},
			Children: []FieldAnnotation{{Name: "Field Code", Value: string(code), Bytes: [2]int{codeStart, codeStart}}, valField},
		})
	}
	var fields []FieldAnnotation
	if len(children) > 0 {
		fields = append(fields, FieldAnnotation{Name: "Fields", Bytes: [2]int{groupStart, pos - 1}, Children: children})
	}
	if pos < len(raw) {
		fields = append(fields, FieldAnnotation{Name: "Terminator", Value: 0, Bytes: [2]int{pos, pos}})
		pos++
	}
	return fields, pos
}

var txStatusMeaning = map[byte]string{
	'I': "Idle",
	'T': "InTransaction",
	'E': "Failed",
}

// --- tagged (post-startup) messages: FE and BE ---

// annotateFields decodes a single tagged message (5-byte header already
// present in raw) into a field tree. msg is the already-decoded pgproto3
// value, so the auth-type state needed to disambiguate FE tag 'p' has
// already been applied by the caller (see Decode).
func annotateFields(msg pgproto3.Message, raw []byte) []FieldAnnotation {
	fields := []FieldAnnotation{
		{Name: "Type Identifier", Value: string(raw[0]), Bytes: [2]int{0, 0}},
		{Name: "Message Length", Value: binary.BigEndian.Uint32(raw[1:5]), Bytes: [2]int{1, 4}},
	}
	pos := 5
	var f FieldAnnotation

	switch m := msg.(type) {

	// ---- Frontend (C2S) ----

	case *pgproto3.Query:
		fields = append(fields, fCStringRest(raw, pos, "SQL Query String"))
		pos = len(raw)

	case *pgproto3.Parse:
		f, pos = fCString(raw, pos, "Statement Name")
		fields = append(fields, f)
		f, pos = fCString(raw, pos, "Query String")
		fields = append(fields, f)
		var countField FieldAnnotation
		countField, pos = fUint16(raw, pos, "Parameter OID Count")
		fields = append(fields, countField)
		n := int(countField.Value.(uint16))
		if n > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < n && pos+4 <= len(raw); i++ {
				oidField, next := fUint32(raw, pos, fmt.Sprintf("OID[%d]", i))
				children = append(children, oidField)
				pos = next
			}
			fields = append(fields, FieldAnnotation{Name: "Parameter OIDs", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}

	case *pgproto3.Bind:
		f, pos = fCString(raw, pos, "Destination Portal")
		fields = append(fields, f)
		f, pos = fCString(raw, pos, "Prepared Statement")
		fields = append(fields, f)

		var pfcCount FieldAnnotation
		pfcCount, pos = fUint16(raw, pos, "Parameter Format Code Count")
		fields = append(fields, pfcCount)
		nPFC := int(pfcCount.Value.(uint16))
		if nPFC > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < nPFC && pos+2 <= len(raw); i++ {
				fc, next := fInt16(raw, pos, fmt.Sprintf("Format Code[%d]", i))
				children = append(children, fc)
				pos = next
			}
			fields = append(fields, FieldAnnotation{Name: "Parameter Format Codes", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}

		var paramCount FieldAnnotation
		paramCount, pos = fUint16(raw, pos, "Parameter Count")
		fields = append(fields, paramCount)
		nParams := int(paramCount.Value.(uint16))
		if nParams > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < nParams && pos+4 <= len(raw); i++ {
				var pField FieldAnnotation
				pField, pos = fLengthPrefixedOrNull(raw, pos, fmt.Sprintf("Parameter[%d] Length", i), fmt.Sprintf("Parameter[%d]", i))
				children = append(children, pField)
			}
			fields = append(fields, FieldAnnotation{Name: "Parameters", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}

		var rfcCount FieldAnnotation
		rfcCount, pos = fUint16(raw, pos, "Result Format Code Count")
		fields = append(fields, rfcCount)
		nRFC := int(rfcCount.Value.(uint16))
		if nRFC > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < nRFC && pos+2 <= len(raw); i++ {
				fc, next := fInt16(raw, pos, fmt.Sprintf("Result Format Code[%d]", i))
				children = append(children, fc)
				pos = next
			}
			fields = append(fields, FieldAnnotation{Name: "Result Format Codes", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}
		_ = m

	case *pgproto3.Describe:
		fields = append(fields, FieldAnnotation{Name: "Object Type", Value: string(raw[pos]), Bytes: [2]int{pos, pos}})
		pos++
		f, pos = fCString(raw, pos, "Name")
		fields = append(fields, f)

	case *pgproto3.Execute:
		f, pos = fCString(raw, pos, "Portal")
		fields = append(fields, f)
		f, pos = fUint32(raw, pos, "Max Rows")
		fields = append(fields, f)

	case *pgproto3.Close:
		fields = append(fields, FieldAnnotation{Name: "Object Type", Value: string(raw[pos]), Bytes: [2]int{pos, pos}})
		pos++
		f, pos = fCString(raw, pos, "Name")
		fields = append(fields, f)

	case *pgproto3.Flush, *pgproto3.Sync, *pgproto3.Terminate:
		// No payload beyond the 5-byte header.

	case *pgproto3.PasswordMessage:
		// Overloaded tag 'p': this is the fallback interpretation used when
		// no SASL/GSS authentication is in progress (see sess.getAuthType).
		fields = append(fields, fCStringRest(raw, pos, "Password"))
		pos = len(raw)

	case *pgproto3.SASLInitialResponse:
		f, pos = fCString(raw, pos, "Auth Mechanism")
		fields = append(fields, f)
		var lenField FieldAnnotation
		lenField, pos = fInt32(raw, pos, "SASL Data Length")
		fields = append(fields, lenField)
		if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "SASL Data (client-first-message)"))
		}
		pos = len(raw)

	case *pgproto3.SASLResponse:
		fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "SASL Data (client-final-message)"))
		pos = len(raw)

	case *pgproto3.GSSResponse:
		fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "GSS Data"))
		pos = len(raw)

	case *pgproto3.FunctionCall:
		f, pos = fUint32(raw, pos, "Function OID")
		fields = append(fields, f)
		var argFCCount FieldAnnotation
		argFCCount, pos = fUint16(raw, pos, "Argument Format Code Count")
		fields = append(fields, argFCCount)
		nAFC := int(argFCCount.Value.(uint16))
		if nAFC > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < nAFC && pos+2 <= len(raw); i++ {
				fc, next := fUint16(raw, pos, fmt.Sprintf("Format Code[%d]", i))
				children = append(children, fc)
				pos = next
			}
			fields = append(fields, FieldAnnotation{Name: "Argument Format Codes", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}
		var argCount FieldAnnotation
		argCount, pos = fUint16(raw, pos, "Argument Count")
		fields = append(fields, argCount)
		nArgs := int(argCount.Value.(uint16))
		if nArgs > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := 0; i < nArgs && pos+4 <= len(raw); i++ {
				var aField FieldAnnotation
				aField, pos = fLengthPrefixedOrNull(raw, pos, fmt.Sprintf("Argument[%d] Length", i), fmt.Sprintf("Argument[%d]", i))
				children = append(children, aField)
			}
			fields = append(fields, FieldAnnotation{Name: "Arguments", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}
		if pos+2 <= len(raw) {
			f, pos = fUint16(raw, pos, "Result Format Code")
			fields = append(fields, f)
		}

	case *pgproto3.CopyFail:
		f, pos = fCString(raw, pos, "Message")
		fields = append(fields, f)

	// CopyData/CopyDone/CopyFail's tag ('d'/'c'/'f') can appear in either
	// direction. The FE/BE cases below are handled by shared struct types.

	// ---- Backend (S2C) ----

	case *pgproto3.AuthenticationOk:
		f, pos = fUint32(raw, pos, "Auth Type (0 = Ok)")
		fields = append(fields, f)

	case *pgproto3.AuthenticationCleartextPassword:
		f, pos = fUint32(raw, pos, "Auth Type (3 = CleartextPassword)")
		fields = append(fields, f)

	case *pgproto3.AuthenticationMD5Password:
		f, pos = fUint32(raw, pos, "Auth Type (5 = MD5Password)")
		fields = append(fields, f)
		fields = append(fields, fRawBytes(raw, pos, pos+3, "Salt"))
		pos += 4

	case *pgproto3.AuthenticationGSS:
		f, pos = fUint32(raw, pos, "Auth Type (7 = GSS)")
		fields = append(fields, f)

	case *pgproto3.AuthenticationGSSContinue:
		f, pos = fUint32(raw, pos, "Auth Type (8 = GSSContinue)")
		fields = append(fields, f)
		if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "GSS Data"))
		}
		pos = len(raw)

	case *pgproto3.AuthenticationSASL:
		f, pos = fUint32(raw, pos, "Auth Type (10 = SASL)")
		fields = append(fields, f)
		groupStart := pos
		var children []FieldAnnotation
		for pos < len(raw)-1 {
			var mech FieldAnnotation
			mech, pos = fCString(raw, pos, fmt.Sprintf("Mechanism[%d]", len(children)))
			children = append(children, mech)
		}
		if len(children) > 0 {
			fields = append(fields, FieldAnnotation{Name: "Auth Mechanisms", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}
		if pos < len(raw) {
			fields = append(fields, FieldAnnotation{Name: "Terminator", Value: 0, Bytes: [2]int{pos, pos}})
			pos++
		}

	case *pgproto3.AuthenticationSASLContinue:
		f, pos = fUint32(raw, pos, "Auth Type (11 = SASLContinue)")
		fields = append(fields, f)
		if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "SASL Data (server-first-message)"))
		}
		pos = len(raw)

	case *pgproto3.AuthenticationSASLFinal:
		f, pos = fUint32(raw, pos, "Auth Type (12 = SASLFinal)")
		fields = append(fields, f)
		if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "SASL Data (server-final-message)"))
		}
		pos = len(raw)

	case *pgproto3.BackendKeyData:
		f, pos = fUint32(raw, pos, "Backend PID")
		fields = append(fields, f)
		// Same variable-length secret key as CancelRequest above: fixed at 4
		// bytes before protocol 3.2, Byte(n) up to 256 bytes (32 in practice)
		// as of 3.2. A 4-byte key renders as a number. Anything longer
		// renders as raw bytes.
		if len(m.SecretKey) == 4 {
			f, pos = fUint32(raw, pos, "Secret Key")
			fields = append(fields, f)
		} else if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "Secret Key"))
			pos = len(raw)
		}

	case *pgproto3.ParameterStatus:
		f, pos = fCString(raw, pos, "Parameter Name")
		fields = append(fields, f)
		f, pos = fCString(raw, pos, "Parameter Value")
		fields = append(fields, f)

	case *pgproto3.ReadyForQuery:
		label, known := txStatusMeaning[m.TxStatus]
		if !known {
			label = "Unknown"
		}
		fields = append(fields, FieldAnnotation{Name: "Transaction Status", Value: label, Bytes: [2]int{pos, pos}})
		pos++

	case *pgproto3.RowDescription:
		var countField FieldAnnotation
		countField, pos = fUint16(raw, pos, "Field Count")
		fields = append(fields, countField)
		for i := range m.Fields {
			colStart := pos
			var children []FieldAnnotation
			var cf FieldAnnotation
			cf, pos = fCString(raw, pos, "Name")
			children = append(children, cf)
			cf, pos = fUint32(raw, pos, "Table OID")
			children = append(children, cf)
			cf, pos = fUint16(raw, pos, "Column Attribute Number")
			children = append(children, cf)
			cf, pos = fUint32(raw, pos, "Data Type OID")
			children = append(children, cf)
			cf, pos = fInt16(raw, pos, "Data Type Size")
			children = append(children, cf)
			cf, pos = fInt32(raw, pos, "Type Modifier")
			children = append(children, cf)
			cf, pos = fInt16(raw, pos, "Format Code")
			children = append(children, cf)
			fields = append(fields, FieldAnnotation{
				Name:     fmt.Sprintf("Column[%d]: %s", i, m.Fields[i].Name),
				Bytes:    [2]int{colStart, pos - 1},
				Children: children,
			})
		}

	case *pgproto3.DataRow:
		var countField FieldAnnotation
		countField, pos = fUint16(raw, pos, "Column Count")
		fields = append(fields, countField)
		for i := range m.Values {
			var colField FieldAnnotation
			colField, pos = fLengthPrefixedOrNull(raw, pos, fmt.Sprintf("Column[%d] Length", i), fmt.Sprintf("Column[%d]", i))
			fields = append(fields, colField)
		}

	case *pgproto3.CommandComplete:
		fields = append(fields, fCStringRest(raw, pos, "Command Tag"))
		pos = len(raw)

	case *pgproto3.EmptyQueryResponse, *pgproto3.ParseComplete, *pgproto3.BindComplete,
		*pgproto3.CloseComplete, *pgproto3.NoData, *pgproto3.PortalSuspended:
		// No payload beyond the 5-byte header.

	case *pgproto3.ErrorResponse:
		var f2 []FieldAnnotation
		f2, pos = annotateErrorOrNotice(raw, pos)
		fields = append(fields, f2...)

	case *pgproto3.NoticeResponse:
		var f2 []FieldAnnotation
		f2, pos = annotateErrorOrNotice(raw, pos)
		fields = append(fields, f2...)

	case *pgproto3.ParameterDescription:
		var declared FieldAnnotation
		declared, pos = fUint16(raw, pos, "Declared Parameter Count")
		fields = append(fields, declared)
		if len(m.ParameterOIDs) > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := range m.ParameterOIDs {
				if pos+4 > len(raw) {
					break
				}
				oidField, next := fUint32(raw, pos, fmt.Sprintf("OID[%d]", i))
				children = append(children, oidField)
				pos = next
			}
			fields = append(fields, FieldAnnotation{Name: "Parameter OIDs", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}

	case *pgproto3.NotificationResponse:
		f, pos = fUint32(raw, pos, "Notifying Backend PID")
		fields = append(fields, f)
		f, pos = fCString(raw, pos, "Channel")
		fields = append(fields, f)
		f, pos = fCString(raw, pos, "Payload")
		fields = append(fields, f)

	case *pgproto3.NegotiateProtocolVersion:
		// Named as the docs name it, but the server sends a whole protocol
		// version code here rather than a bare minor number, so 3.0 arrives
		// as 196608. Decoded like StartupMessage's own version for that
		// reason: the two are the same kind of value and are read together.
		fields = append(fields, FieldAnnotation{
			Name:  "Newest Minor Protocol",
			Value: protocolVersionString(binary.BigEndian.Uint32(raw[pos : pos+4])),
			Bytes: [2]int{pos, pos + 3},
		})
		pos += 4
		var countField FieldAnnotation
		countField, pos = fUint32(raw, pos, "Unrecognized Option Count")
		fields = append(fields, countField)
		if len(m.UnrecognizedOptions) > 0 {
			groupStart := pos
			var children []FieldAnnotation
			for i := range m.UnrecognizedOptions {
				var opt FieldAnnotation
				opt, pos = fCString(raw, pos, fmt.Sprintf("Option[%d]", i))
				children = append(children, opt)
			}
			fields = append(fields, FieldAnnotation{Name: "Unrecognized Options", Bytes: [2]int{groupStart, pos - 1}, Children: children})
		}

	case *pgproto3.CopyInResponse:
		fields = append(fields, FieldAnnotation{Name: "Overall Format", Value: formatCodeName(m.OverallFormat), Bytes: [2]int{pos, pos}})
		pos++
		var f2 []FieldAnnotation
		f2, pos = annotateCopyColumnFormats(raw, pos, m.ColumnFormatCodes)
		fields = append(fields, f2...)

	case *pgproto3.CopyOutResponse:
		fields = append(fields, FieldAnnotation{Name: "Overall Format", Value: formatCodeName(m.OverallFormat), Bytes: [2]int{pos, pos}})
		pos++
		var f2 []FieldAnnotation
		f2, pos = annotateCopyColumnFormats(raw, pos, m.ColumnFormatCodes)
		fields = append(fields, f2...)

	case *pgproto3.CopyBothResponse:
		fields = append(fields, FieldAnnotation{Name: "Overall Format", Value: formatCodeName(m.OverallFormat), Bytes: [2]int{pos, pos}})
		pos++
		var f2 []FieldAnnotation
		f2, pos = annotateCopyColumnFormats(raw, pos, m.ColumnFormatCodes)
		fields = append(fields, f2...)

	case *pgproto3.FunctionCallResponse:
		var resultField FieldAnnotation
		resultField, pos = fLengthPrefixedOrNull(raw, pos, "Result Length", "Result")
		fields = append(fields, resultField)

	case *pgproto3.CopyData:
		fields = append(fields, annotateCopyData(raw, pos))
		pos = len(raw)

	case *pgproto3.CopyDone:
		// No payload beyond the 5-byte header.

	default:
		if pos <= len(raw)-1 {
			fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "Unhandled Payload"))
		}
		pos = len(raw)
	}

	// Any bytes a decoder above didn't account for (should only happen for
	// malformed input the pgproto3 struct nonetheless accepted) still get
	// covered, so the contiguity invariant holds for every packet we emit.
	if pos < len(raw) {
		fields = append(fields, fRawBytes(raw, pos, len(raw)-1, "Unparsed trailing bytes"))
	}

	return fields
}

func formatCodeName(b byte) string {
	if b == 1 {
		return "Binary"
	}
	return "Text"
}

// --- streaming replication sub-protocol ---
//
// Physical and logical replication both ride inside CopyData once the
// connection has switched to copy-both mode: see
// https://www.postgresql.org/docs/current/protocol-replication.html.
// pgproto3 treats CopyData as an opaque blob, so its inner messages are
// annotated by hand here, the same way the rest of this file computes
// offsets by hand. The four submessages are told apart by their own first
// byte ('w', 'k', 'r', 'h'), which is enough on its own: those four bytes
// never collide, so no direction needs to be threaded through the switch in
// annotateFields.

// pgReplicationEpoch is midnight 2000-01-01 UTC, the epoch every clock field
// in the replication sub-protocol counts microseconds from.
var pgReplicationEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

// lsnString renders a 64-bit Log Sequence Number in Postgres's usual X/Y
// form: the high 32 bits, a slash, the low 32 bits, both in hex.
func lsnString(v uint64) string {
	return fmt.Sprintf("%X/%X", uint32(v>>32), uint32(v))
}

// fWALPos reads an Int64 WAL position and renders it as an LSN.
func fWALPos(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := binary.BigEndian.Uint64(raw[pos : pos+8])
	return FieldAnnotation{Name: name, Value: lsnString(v), Bytes: [2]int{pos, pos + 7}}, pos + 8
}

// fReplicationClock reads an Int64 count of microseconds since
// pgReplicationEpoch and renders it as a readable UTC timestamp.
func fReplicationClock(raw []byte, pos int, name string) (FieldAnnotation, int) {
	v := int64(binary.BigEndian.Uint64(raw[pos : pos+8]))
	t := pgReplicationEpoch.Add(time.Duration(v) * time.Microsecond)
	return FieldAnnotation{Name: name, Value: t.Format(time.RFC3339Nano), Bytes: [2]int{pos, pos + 7}}, pos + 8
}

// fReplyRequested reads the trailing Byte1 flag shared by the keepalive and
// standby status update messages.
func fReplyRequested(raw []byte, pos int) FieldAnnotation {
	return FieldAnnotation{Name: "Reply Requested", Value: raw[pos] != 0, Bytes: [2]int{pos, pos}}
}

// annotateCopyData decodes a CopyData payload. Outside a replication stream
// this is opaque COPY row data with no structure of its own, and stays a
// single "Copy Data" field. When the payload's first byte identifies one of
// the four replication submessages, and the payload is exactly the length that
// submessage requires, it is expanded into Children instead. A payload that
// merely starts with one of those bytes by coincidence, or is truncated,
// falls back to the same raw rendering rather than guessing.
func annotateCopyData(raw []byte, pos int) FieldAnnotation {
	start := pos
	end := len(raw) - 1
	if end < pos {
		return FieldAnnotation{Name: "Copy Data", Value: "", Bytes: [2]int{start, pos - 1}}
	}

	var children []FieldAnnotation
	switch raw[pos] {
	case 'w':
		children = annotateXLogData(raw, pos, end)
	case 'k':
		children = annotatePrimaryKeepalive(raw, pos, end)
	case 'r':
		children = annotateStandbyStatusUpdate(raw, pos, end)
	case 'h':
		children = annotateHotStandbyFeedback(raw, pos, end)
	}
	if children == nil {
		return fRawBytes(raw, pos, end, "Copy Data")
	}
	return FieldAnnotation{Name: "Copy Data", Bytes: [2]int{start, end}, Children: children}
}

// annotateXLogData decodes a backend XLogData message: Byte1('w'), Int64 WAL
// data start, Int64 current end of WAL on the server, Int64 server clock,
// then the WAL data itself (which may legitimately be zero bytes long).
func annotateXLogData(raw []byte, pos, end int) []FieldAnnotation {
	const headerLen = 1 + 8 + 8 + 8
	if end-pos+1 < headerLen {
		return nil
	}
	var fields []FieldAnnotation
	fields = append(fields, FieldAnnotation{Name: "Subtype", Value: "XLogData (w)", Bytes: [2]int{pos, pos}})
	pos++
	var f FieldAnnotation
	f, pos = fWALPos(raw, pos, "WAL Data Start")
	fields = append(fields, f)
	f, pos = fWALPos(raw, pos, "Current End of WAL on Server")
	fields = append(fields, f)
	f, pos = fReplicationClock(raw, pos, "Server Clock")
	fields = append(fields, f)
	fields = append(fields, fRawBytes(raw, pos, end, "WAL Data"))
	return fields
}

// annotatePrimaryKeepalive decodes a backend Primary keepalive message:
// Byte1('k'), Int64 current end of WAL on the server, Int64 server clock,
// Byte1 reply-requested flag. Exactly 18 bytes, no variable part.
func annotatePrimaryKeepalive(raw []byte, pos, end int) []FieldAnnotation {
	const wantLen = 1 + 8 + 8 + 1
	if end-pos+1 != wantLen {
		return nil
	}
	var fields []FieldAnnotation
	fields = append(fields, FieldAnnotation{Name: "Subtype", Value: "Primary keepalive message (k)", Bytes: [2]int{pos, pos}})
	pos++
	var f FieldAnnotation
	f, pos = fWALPos(raw, pos, "Current End of WAL on Server")
	fields = append(fields, f)
	f, pos = fReplicationClock(raw, pos, "Server Clock")
	fields = append(fields, f)
	fields = append(fields, fReplyRequested(raw, pos))
	return fields
}

// annotateStandbyStatusUpdate decodes a frontend Standby status update:
// Byte1('r'), Int64 last WAL byte+1 written, Int64 last WAL byte+1 flushed,
// Int64 last WAL byte+1 applied, Int64 client clock, Byte1 reply-requested
// flag. Exactly 34 bytes.
func annotateStandbyStatusUpdate(raw []byte, pos, end int) []FieldAnnotation {
	const wantLen = 1 + 8 + 8 + 8 + 8 + 1
	if end-pos+1 != wantLen {
		return nil
	}
	var fields []FieldAnnotation
	fields = append(fields, FieldAnnotation{Name: "Subtype", Value: "Standby status update (r)", Bytes: [2]int{pos, pos}})
	pos++
	var f FieldAnnotation
	f, pos = fWALPos(raw, pos, "Last WAL Byte Written")
	fields = append(fields, f)
	f, pos = fWALPos(raw, pos, "Last WAL Byte Flushed")
	fields = append(fields, f)
	f, pos = fWALPos(raw, pos, "Last WAL Byte Applied")
	fields = append(fields, f)
	f, pos = fReplicationClock(raw, pos, "Client Clock")
	fields = append(fields, f)
	fields = append(fields, fReplyRequested(raw, pos))
	return fields
}

// annotateHotStandbyFeedback decodes a frontend Hot standby feedback
// message: Byte1('h'), Int64 client clock, Int32 current global xmin, Int32
// global xmin epoch, Int32 lowest catalog xmin among the standby's
// replication slots, Int32 catalog xmin epoch. Exactly 25 bytes.
func annotateHotStandbyFeedback(raw []byte, pos, end int) []FieldAnnotation {
	const wantLen = 1 + 8 + 4 + 4 + 4 + 4
	if end-pos+1 != wantLen {
		return nil
	}
	var fields []FieldAnnotation
	fields = append(fields, FieldAnnotation{Name: "Subtype", Value: "Hot standby feedback message (h)", Bytes: [2]int{pos, pos}})
	pos++
	var f FieldAnnotation
	f, pos = fReplicationClock(raw, pos, "Client Clock")
	fields = append(fields, f)
	f, pos = fUint32(raw, pos, "Current Global Xmin")
	fields = append(fields, f)
	f, pos = fUint32(raw, pos, "Global Xmin Epoch")
	fields = append(fields, f)
	f, pos = fUint32(raw, pos, "Lowest Catalog Xmin")
	fields = append(fields, f)
	f, pos = fUint32(raw, pos, "Catalog Xmin Epoch")
	fields = append(fields, f)
	return fields
}

func annotateCopyColumnFormats(raw []byte, pos int, codes []uint16) ([]FieldAnnotation, int) {
	var fields []FieldAnnotation
	var countField FieldAnnotation
	countField, pos = fUint16(raw, pos, "Column Count")
	fields = append(fields, countField)
	if len(codes) > 0 {
		groupStart := pos
		var children []FieldAnnotation
		for i := range codes {
			if pos+2 > len(raw) {
				break
			}
			fc, next := fUint16(raw, pos, fmt.Sprintf("Column[%d] Format", i))
			children = append(children, fc)
			pos = next
		}
		fields = append(fields, FieldAnnotation{Name: "Column Format Codes", Bytes: [2]int{groupStart, pos - 1}, Children: children})
	}
	return fields, pos
}
