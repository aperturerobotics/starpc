package srpc

import (
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// TestYamuxStreamResetKeepsConnectionCause checks that a stream reset by its
// connection closing reports ErrReset and keeps the connection's error.
func TestYamuxStreamResetKeepsConnectionCause(t *testing.T) {
	// Run a muxed conn over a pipe whose reads fail with the close reason.
	reason := errors.New("peer is not an active session")
	conn, peer := net.Pipe()
	muxed, err := NewMuxedConn(&reasonConn{Conn: conn, reason: reason}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer muxed.Close()
	go func() { _, _ = io.Copy(io.Discard, peer) }()

	// Open a stream, then close the connection under it.
	strm, err := muxed.OpenStream(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_ = peer.Close()
	_, err = strm.Read(make([]byte, 1))
	if !errors.Is(err, ErrReset) || !strings.Contains(err.Error(), reason.Error()) {
		t.Fatalf("read after connection close: %v, want ErrReset with %q", err, reason)
	}
}

// reasonConn reports reason in place of each read, write and write deadline
// error, as a connection closed with a reason does.
type reasonConn struct {
	net.Conn
	// reason replaces the conn's errors.
	reason error
}

// Read reads from the conn, replacing an error with the reason.
func (c *reasonConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if err != nil {
		err = c.reason
	}
	return n, err
}

// Write writes to the conn, replacing an error with the reason.
func (c *reasonConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if err != nil {
		err = c.reason
	}
	return n, err
}

// SetWriteDeadline sets the write deadline, replacing an error with the
// reason.
func (c *reasonConn) SetWriteDeadline(t time.Time) error {
	if err := c.Conn.SetWriteDeadline(t); err != nil {
		return c.reason
	}
	return nil
}
