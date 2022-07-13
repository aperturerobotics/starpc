package srpc

import (
	"context"
	"net"
)

// AcceptMuxedListener accepts incoming connections from a net.Listener.
//
// Uses the default mplex muxer.
func AcceptMuxedListener(ctx context.Context, lis net.Listener, srv *Server) error {
	for {
		nc, err := lis.Accept()
		if err != nil {
			return err
		}

		mc, err := NewMuxedConn(nc, false)
		if err != nil {
			_ = nc.Close()
			continue
		}

		if err := srv.AcceptMuxedConn(ctx, mc); err != nil {
			_ = nc.Close()
			continue
		}
	}
}
