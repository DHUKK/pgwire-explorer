// Package proxy relays a Postgres wire-protocol v3 conversation between a
// client and a real server, byte for byte, while recording an annotated copy
// of it into a capture document.
package proxy

import (
	"io"
	"log"
	"net"
	"strings"

	"pgwire-explorer/internal/capture"
	"pgwire-explorer/internal/pgproto"
)

// Run starts listening on listenAddr and relays every accepted connection to
// upstreamAddr, recording the exchange into cap. It returns as soon as the
// listener is up. Closing the returned listener stops the accept loop.
func Run(listenAddr, upstreamAddr string, cap *capture.SessionCapture) (net.Listener, error) {
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return nil, err
	}

	log.Printf("Proxy recording on %s -> %s\n", listenAddr, upstreamAddr)

	go func() {
		for {
			clientConn, err := listener.Accept()
			if err != nil {
				return
			}
			// Must be concurrent: a CancelRequest arrives on a *separate*
			// connection while the query it cancels is still in flight on
			// the first one.
			go handleSession(clientConn, upstreamAddr, cap)
		}
	}()

	return listener, nil
}

func handleSession(clientConn net.Conn, upstreamAddr string, cap *capture.SessionCapture) {
	defer clientConn.Close()

	dbConn, err := net.Dial("tcp", upstreamAddr)
	if err != nil {
		log.Printf("Failed to connect to backend postgres: %v", err)
		return
	}
	defer dbConn.Close()

	sess := cap.NewSession(clientConn.RemoteAddr().String(), upstreamAddr)
	defer sess.Close()

	startTime := sess.StartedAt
	var clientOffset, dbOffset int64

	// Goroutine 1: Client -> Postgres Server
	go func() {
		startupDone := false // the client's first frame is untagged
		for {
			raw, err := pgproto.ReadRawFrame(clientConn, &startupDone)
			if err != nil {
				return
			}

			// SSLRequest/GSSENCRequest are answered with a bare single byte,
			// not a wire v3 message, so we must not forward them: the reply
			// would stall the S2C framer waiting for a 5-byte header. Deny
			// here to keep the whole session plaintext and inspectable.
			if name, deny, ok := pgproto.PreStartupMessage(raw); ok && deny {
				sess.SetSSLRequested(false)

				sess.Record(pgproto.ClientToServer, raw, clientOffset, startTime)
				clientOffset += int64(len(raw))

				if _, err := clientConn.Write([]byte{'N'}); err != nil {
					log.Printf("Failed to write SSL/GSSENC denial to client: %v", err)
					return
				}
				// The reply to SSLRequest/GSSENCRequest is a bare byte, not a
				// wire message, so there is nothing for pgproto to decode: it
				// is annotated by hand. "SSLRequest" becomes "SSLResponse".
				respName := strings.TrimSuffix(name, "Request") + "Response"
				sess.RecordRaw(
					pgproto.ServerToClient, []byte{'N'}, dbOffset, startTime,
					"N", respName,
					[]pgproto.FieldAnnotation{{
						Name:  "Response",
						Value: "N",
						Bytes: [2]int{0, 0},
					}},
				)
				dbOffset++

				// The client's next message is still in startup format.
				startupDone = false
				continue
			}

			// Forward immediately (zero added latency for the real query),
			// then decode and record off the critical path.
			if err := writeAll(dbConn, raw); err != nil {
				log.Printf("Failed to forward client message to backend: %v", err)
				return
			}

			sess.Record(pgproto.ClientToServer, raw, clientOffset, startTime)
			clientOffset += int64(len(raw))
		}
	}()

	// Goroutine 2: Postgres Server -> Client
	startupDone := true // server responses always carry a wire v3 header
	for {
		raw, err := pgproto.ReadRawFrame(dbConn, &startupDone)
		if err != nil {
			break
		}

		if err := writeAll(clientConn, raw); err != nil {
			log.Printf("Failed to forward backend message to client: %v", err)
			break
		}

		sess.Record(pgproto.ServerToClient, raw, dbOffset, startTime)
		dbOffset += int64(len(raw))
	}
	// Closing dbConn/clientConn (deferred above) makes the client->server
	// goroutine's next read fail, so it exits on its own. Nothing to join.
}

// writeAll ensures the full buffer reaches the peer. net.Conn.Write can perform
// a short write, and ignoring either return value would silently corrupt the
// relayed stream.
func writeAll(w io.Writer, buf []byte) error {
	for len(buf) > 0 {
		n, err := w.Write(buf)
		if err != nil {
			return err
		}
		buf = buf[n:]
	}
	return nil
}
