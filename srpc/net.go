package srpc

import (
	"context"
	"net"
)

// Dial dials a remote server using TCP with the default muxed conn type.
func Dial(addr string) (Client, error) {
	nconn, err := net.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	muxedConn, err := NewMuxedConn(nconn, false, nil)
	if err != nil {
		return nil, err
	}
	return NewClientWithMuxedConn(muxedConn), nil
}

// Listen listens for incoming connections with TCP on the given address with the default muxed conn type.
// Returns on any fatal error or if ctx was canceled.
// errCh is an optional error channel (can be nil)
func Listen(ctx context.Context, addr string, srv *Server, errCh <-chan error) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}

	listenErrCh := make(chan error, 1)
	go func() {
		listenErrCh <- AcceptMuxedListener(ctx, lis, srv, nil)
		_ = lis.Close()
	}()

	select {
	case <-ctx.Done():
		return context.Canceled
	case err := <-errCh:
		return err
	case err := <-listenErrCh:
		return err
	}
}
