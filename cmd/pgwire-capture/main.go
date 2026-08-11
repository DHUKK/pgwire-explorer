// Command pgwire-capture is a Postgres wire-protocol (v3) proxy. It sits
// between a client (e.g. psql) and a real Postgres server, relays every byte
// unmodified in both directions, and records a fully field-annotated copy of
// the conversation to a JSON capture file for later inspection.
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"pgwire-explorer/internal/capture"
	"pgwire-explorer/internal/proxy"
)

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:5433", "address to accept client connections on")
	upstreamAddr := flag.String("upstream", "127.0.0.1:5432", "address of the real Postgres server to relay to")
	outFile := flag.String("out", "postgres_session.json", "capture file to write on shutdown")
	flag.Parse()

	cap := capture.New()

	listener, err := proxy.Run(*listenAddr, *upstreamAddr, cap)
	if err != nil {
		log.Fatalf("Listen error: %v", err)
	}
	defer listener.Close()

	log.Printf("Press Ctrl+C to stop and save capture file to '%s'\n", *outFile)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	listener.Close()

	stats, err := cap.Write(*outFile)
	if err != nil {
		log.Fatalf("Failed to save capture: %v", err)
	}
	log.Printf("Successfully recorded %d sessions (%d packets) to '%s'\n", stats.Sessions, stats.Packets, *outFile)
}
