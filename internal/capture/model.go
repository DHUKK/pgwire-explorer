// Package capture defines the on-disk capture document: the schema written by
// the proxy and read by the explorer UI. It owns timestamps, stream offsets
// and session grouping, and delegates field-level decoding to
// internal/pgproto.
package capture

import (
	"sync"
	"time"

	"pgwire-explorer/internal/pgproto"
)

// SchemaVersion is written to every capture file.
//
// "2.0" groups packets into sessions, one per TCP connection accepted by the
// proxy, rather than a single flat list. A CancelRequest arrives on its own
// connection with its own stream offsets and start time, so it needs its own
// session rather than sharing a timeline with unrelated packets. Every field
// inside a packet keeps its v1.0 name and meaning.
const SchemaVersion = "2.0"

type PacketRecord struct {
	ID           int                       `json:"id"`
	Direction    string                    `json:"direction"`    // "C2S" (Client->Server) or "S2C" (Server->Client)
	TimestampMs  float64                   `json:"timestamp_ms"` // Relative ms since *this session's* start
	StreamOffset int64                     `json:"stream_offset"`
	Length       int                       `json:"length"`
	RawHex       string                    `json:"raw_hex"`
	TypeChar     string                    `json:"type_char,omitempty"`
	TypeName     string                    `json:"type_name"`
	Fields       []pgproto.FieldAnnotation `json:"fields,omitempty"`
}

// Session groups every packet observed on one TCP connection between a client
// and the proxy, and the corresponding connection the proxy opened to the real
// Postgres server. A CancelRequest always arrives on its own connection, so it
// always gets its own Session, with its own timestamps and stream offsets.
type Session struct {
	ID           int            `json:"id"`
	ClientAddr   string         `json:"client_addr"`
	ServerAddr   string         `json:"server_addr"`
	StartedAt    time.Time      `json:"started_at"`
	EndedAt      time.Time      `json:"ended_at,omitempty"`
	SSLRequested bool           `json:"ssl_requested"`
	SSLAccepted  bool           `json:"ssl_accepted"`
	Packets      []PacketRecord `json:"packets"`

	mu sync.Mutex

	// lastAuthType tracks the most recent BE Authentication* subtype seen on
	// this session, so a subsequent FE tag 'p' can be disambiguated into
	// PasswordMessage / SASLInitialResponse / SASLResponse / GSSResponse.
	// The proxy keeps the client and server streams in separate goroutines
	// and decodes each packet independently, so this cross-packet state has
	// to live somewhere shared, which is here.
	lastAuthType uint32
}

// SetSSLRequested records that the client asked to encrypt the connection, and
// whether the proxy agreed. Guarded because it is set from the client->server
// goroutine while the writer may be marshaling.
func (s *Session) SetSSLRequested(accepted bool) {
	s.mu.Lock()
	s.SSLRequested = true
	s.SSLAccepted = accepted
	s.mu.Unlock()
}

func (s *Session) setAuthType(t uint32) {
	s.mu.Lock()
	s.lastAuthType = t
	s.mu.Unlock()
}

func (s *Session) getAuthType() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastAuthType
}

// AddPacket appends pkt, assigning its per-session ID in arrival order.
func (s *Session) AddPacket(pkt PacketRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pkt.ID = len(s.Packets) + 1
	s.Packets = append(s.Packets, pkt)
}

// Close stamps the session's end time. Safe to call more than once.
func (s *Session) Close() {
	s.mu.Lock()
	s.EndedAt = time.Now()
	s.mu.Unlock()
}

type SessionCapture struct {
	Version    string     `json:"version"`
	RecordedAt time.Time  `json:"recorded_at"`
	Sessions   []*Session `json:"sessions"`

	mu sync.Mutex // guards the Sessions slice itself (append vs. marshal)
}

// New returns an empty capture stamped with the current time.
func New() *SessionCapture {
	return &SessionCapture{
		Version:    SchemaVersion,
		RecordedAt: time.Now(),
	}
}

// NewSession registers and returns a fresh Session. Called once per accepted
// TCP connection, so IDs are assigned in accept order.
func (sc *SessionCapture) NewSession(clientAddr, serverAddr string) *Session {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	s := &Session{
		ID:         len(sc.Sessions) + 1,
		ClientAddr: clientAddr,
		ServerAddr: serverAddr,
		StartedAt:  time.Now(),
	}
	sc.Sessions = append(sc.Sessions, s)
	return s
}
