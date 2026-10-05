package srpc

import (
	"errors"
	"time"

	yamux "github.com/libp2p/go-yamux/v5"
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
	return n, translateReset(err)
}

// Write writes to the stream, translating stream reset errors.
func (s *yamuxStream) Write(b []byte) (int, error) {
	n, err := s.yamux().Write(b)
	return n, translateReset(err)
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

// translateReset reports a yamux stream reset as ErrReset. A reset caused by
// the connection closing keeps that cause, such as the peer's close reason, in
// its message.
func translateReset(err error) error {
	if !errors.Is(err, yamux.ErrStreamReset) {
		return err
	}
	switch err.(type) {
	case *yamux.Error, *yamux.StreamError:
		return ErrReset
	}
	return &connResetError{err: err}
}

// connResetError is a stream reset caused by the connection closing.
type connResetError struct {
	// err is the yamux reset with its connection error.
	err error
}

// Error returns the reset with its connection error.
func (e *connResetError) Error() string {
	return e.err.Error()
}

// Unwrap returns ErrReset and the yamux reset.
func (e *connResetError) Unwrap() []error {
	return []error{ErrReset, e.err}
}

// _ is a type assertion
var _ MuxedStream = (*yamuxStream)(nil)
