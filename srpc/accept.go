package srpc

import (
	"context"
	"net"

	"github.com/libp2p/go-yamux/v5"
)

// AcceptMuxedListener accepts connections until ctx is canceled or the listener
// fails. Cancellation closes lis to interrupt Accept. A nil yamuxConf uses defaults.
func AcceptMuxedListener(ctx context.Context, lis net.Listener, srv *Server, yamuxConf *yamux.Config) error {
	// Interrupt a blocked Accept when its serving context ends.
	stop := context.AfterFunc(ctx, func() { _ = lis.Close() })
	defer stop()

	// Transfer accepted connections to the server and release rejected ones.
	for {
		nc, err := lis.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
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
