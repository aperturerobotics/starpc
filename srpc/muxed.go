package srpc

import (
	"context"
	"io"
	"time"
)

// MuxedConn represents a connection which has been multiplexed.
type MuxedConn interface {
	io.Closer

	// IsClosed returns whether a connection is fully closed.
	IsClosed() bool

	// OpenStream creates a new stream.
	OpenStream(context.Context) (MuxedStream, error)

	// AcceptStream accepts a stream opened by the other side.
	AcceptStream() (MuxedStream, error)
}

// MuxedStream is a bidirectional io pipe within a connection.
type MuxedStream interface {
	io.Reader
	io.Writer
	io.Closer

	// CloseWrite closes the stream for writing but leaves it open for reading.
	CloseWrite() error

	// CloseRead closes the stream for reading but leaves it open for writing.
	CloseRead() error

	// Reset closes both ends of the stream, telling the remote side to hang up.
	Reset() error

	// SetDeadline sets the read and write deadlines.
	SetDeadline(time.Time) error

	// SetReadDeadline sets the read deadline.
	SetReadDeadline(time.Time) error

	// SetWriteDeadline sets the write deadline.
	SetWriteDeadline(time.Time) error
}
