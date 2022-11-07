package srpc

import (
	"context"
	"net"

	"github.com/libp2p/go-yamux/v4"
)

// AcceptMuxedListener accepts incoming connections from a net.Listener.
//
// Uses the default yamux muxer.
// If yamux conf is nil, uses the defaults.
func AcceptMuxedListener(ctx context.Context, lis net.Listener, srv *Server, yamuxConf *yamux.Config) error {
	for {
		nc, err := lis.Accept()
		if err != nil {
			return err
		}

		mc, err := NewMuxedConn(nc, false, yamuxConf)
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
