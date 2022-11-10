package srpc

import (
	"context"
	"io"

	"github.com/libp2p/go-libp2p/core/network"
)

// Server handles incoming RPC streams with a mux.
type Server struct {
	// invoker is the method invoker
	invoker Invoker
}

// NewServer constructs a new SRPC server.
func NewServer(invoker Invoker) *Server {
	return &Server{
		invoker: invoker,
	}
}

// GetInvoker returns the invoker.
func (s *Server) GetInvoker() Invoker {
	return s.invoker
}

// HandleStream handles an incoming ReadWriteCloser stream.
func (s *Server) HandleStream(ctx context.Context, rwc io.ReadWriteCloser) error {
	subCtx, subCtxCancel := context.WithCancel(ctx)
	defer subCtxCancel()
	serverRPC := NewServerRPC(subCtx, s.invoker)
	prw := NewPacketReadWriter(rwc)
	serverRPC.SetWriter(prw)
	go prw.ReadPump(serverRPC.HandlePacket, serverRPC.HandleStreamClose)
	return serverRPC.Wait(ctx)
}

// AcceptMuxedConn runs a loop which calls Accept on a muxer to handle streams.
//
// Starts HandleStream in a separate goroutine to handle the stream.
// Returns context.Canceled or io.EOF when the loop is complete / closed.
func (s *Server) AcceptMuxedConn(ctx context.Context, mc network.MuxedConn) error {
	for {
		select {
		case <-ctx.Done():
			return context.Canceled
		default:
			if mc.IsClosed() {
				return io.EOF
			}
		}

		muxedStream, err := mc.AcceptStream()
		if err != nil {
			return err
		}
		go func() {
			_ = s.HandleStream(ctx, NewMuxedStreamRwc(muxedStream))
		}()
	}
}
