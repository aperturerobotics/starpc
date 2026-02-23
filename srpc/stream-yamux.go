package srpc

import (
	"errors"
	"time"

	yamux "github.com/libp2p/go-yamux/v4"
)

// yamuxStream wraps a yamux.Stream to implement MuxedStream.
type yamuxStream yamux.Stream

// yamux returns the underlying yamux.Stream.
func (s *yamuxStream) yamux() *yamux.Stream {
	return (*yamux.Stream)(s)
}

// Read reads from the stream, translating stream reset errors.
func (s *yamuxStream) Read(b []byte) (int, error) {
	n, err := s.yamux().Read(b)
	if errors.Is(err, yamux.ErrStreamReset) {
		err = ErrReset
	}
	return n, err
}

// Write writes to the stream, translating stream reset errors.
func (s *yamuxStream) Write(b []byte) (int, error) {
	n, err := s.yamux().Write(b)
	if errors.Is(err, yamux.ErrStreamReset) {
		err = ErrReset
	}
	return n, err
}

// Close closes the stream.
func (s *yamuxStream) Close() error {
	return s.yamux().Close()
}

// CloseWrite closes the stream for writing.
func (s *yamuxStream) CloseWrite() error {
	return s.yamux().CloseWrite()
}

// CloseRead closes the stream for reading.
func (s *yamuxStream) CloseRead() error {
	return s.yamux().CloseRead()
}

// Reset closes both ends of the stream.
func (s *yamuxStream) Reset() error {
	return s.yamux().Reset()
}

// SetDeadline sets the read and write deadlines.
func (s *yamuxStream) SetDeadline(t time.Time) error {
	return s.yamux().SetDeadline(t)
}

// SetReadDeadline sets the read deadline.
func (s *yamuxStream) SetReadDeadline(t time.Time) error {
	return s.yamux().SetReadDeadline(t)
}

// SetWriteDeadline sets the write deadline.
func (s *yamuxStream) SetWriteDeadline(t time.Time) error {
	return s.yamux().SetWriteDeadline(t)
}

// _ is a type assertion
var _ MuxedStream = (*yamuxStream)(nil)
