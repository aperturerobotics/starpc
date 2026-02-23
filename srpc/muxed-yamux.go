package srpc

import (
	"context"

	yamux "github.com/libp2p/go-yamux/v4"
)

// yamuxConn wraps a yamux.Session to implement MuxedConn.
type yamuxConn yamux.Session

// newYamuxConn wraps a yamux.Session as a MuxedConn.
func newYamuxConn(sess *yamux.Session) MuxedConn {
	return (*yamuxConn)(sess)
}

// yamux returns the underlying yamux.Session.
func (c *yamuxConn) yamux() *yamux.Session {
	return (*yamux.Session)(c)
}

// Close closes the underlying yamux session.
func (c *yamuxConn) Close() error {
	return c.yamux().Close()
}

// IsClosed returns whether the connection is closed.
func (c *yamuxConn) IsClosed() bool {
	return c.yamux().IsClosed()
}

// OpenStream creates a new stream.
func (c *yamuxConn) OpenStream(ctx context.Context) (MuxedStream, error) {
	s, err := c.yamux().OpenStream(ctx)
	if err != nil {
		return nil, err
	}
	return (*yamuxStream)(s), nil
}

// AcceptStream accepts an incoming stream.
func (c *yamuxConn) AcceptStream() (MuxedStream, error) {
	s, err := c.yamux().AcceptStream()
	if err != nil {
		return nil, err
	}
	return (*yamuxStream)(s), nil
}

// _ is a type assertion
var _ MuxedConn = (*yamuxConn)(nil)
