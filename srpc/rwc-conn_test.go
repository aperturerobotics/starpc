package srpc

import (
	"bytes"
	"context"
	"io"
	"testing"
)

// blockingRWC wraps a pipe for testing RwcConn.
type blockingRWC struct {
	r io.Reader
	w io.Writer
}

func (b *blockingRWC) Read(p []byte) (int, error)  { return b.r.Read(p) }
func (b *blockingRWC) Write(p []byte) (int, error) { return b.w.Write(p) }
func (b *blockingRWC) Close() error                { return nil }

// TestRwcConnReadBuffering verifies that RwcConn.Read does not drop data
// when the caller's buffer is smaller than the received packet.
func TestRwcConnReadBuffering(t *testing.T) {
	pr, pw := io.Pipe()
	rwc := &blockingRWC{r: pr, w: pw}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	conn := NewRwcConn(ctx, rwc, nil, nil, 10)

	// Write a 100-byte message through the pipe.
	msg := bytes.Repeat([]byte("abcdefghij"), 10) // 100 bytes
	go func() {
		_, _ = pw.Write(msg)
	}()

	// Read in small chunks (16 bytes at a time) to simulate bufio.Reader.
	var got []byte
	buf := make([]byte, 16)
	for len(got) < len(msg) {
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("Read error after %d bytes: %v", len(got), err)
		}
		got = append(got, buf[:n]...)
	}

	if !bytes.Equal(got, msg) {
		t.Fatalf("data mismatch: got %d bytes, want %d bytes\ngot:  %q\nwant: %q", len(got), len(msg), got, msg)
	}
}
