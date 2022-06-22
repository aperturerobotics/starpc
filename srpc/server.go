package srpc

import (
	"context"
	"io"

	"github.com/libp2p/go-libp2p-core/network"
)

// Server handles incoming RPC streams with a mux.
type Server struct {
	// mux is the srpc mux
	mux Mux
}

// NewServer constructs a new SRPC server.
func NewServer(mux Mux) *Server {
	return &Server{
		mux: mux,
	}
}

// HandleStream handles an incoming ReadWriteCloser stream.
func (s *Server) HandleStream(ctx context.Context, rwc io.ReadWriteCloser) error {
	subCtx, subCtxCancel := context.WithCancel(ctx)
	defer subCtxCancel()
	serverRPC := NewServerRPC(subCtx, s.mux)
	prw := NewPacketReadWriter(rwc, serverRPC.HandlePacket)
	serverRPC.SetWriter(prw)
	err := prw.ReadPump()
	_ = rwc.Close()
	return err
}

// AcceptMuxedConn runs a loop which calls Accept on a muxer to handle streams.
//
// Starts HandleStream in a separate goroutine to handle the stream.
// Returns context.Canceled or io.EOF when the loop is complete / closed.
func (s *Server) AcceptMuxedConn(ctx context.Context, mplex network.MuxedConn) error {
	for {
		select {
		case <-ctx.Done():
			return context.Canceled
		default:
			if mplex.IsClosed() {
				return io.EOF
			}
		}

		muxedStream, err := mplex.AcceptStream()
		if err != nil {
			return err
		}
		go func() {
			_ = s.HandleStream(ctx, muxedStream)
		}()
	}
}
