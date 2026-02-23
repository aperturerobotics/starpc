package srpc

import (
	"context"
	"io"
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

// HandleStream handles an incoming stream and runs the read loop.
// Uses length-prefixed packets.
func (s *Server) HandleStream(ctx context.Context, rwc io.ReadWriteCloser) {
	subCtx, subCtxCancel := context.WithCancel(ctx)
	defer subCtxCancel()
	prw := NewPacketReadWriter(rwc)
	serverRPC := NewServerRPC(subCtx, s.invoker, prw)
	prw.ReadPump(serverRPC.HandlePacketData, serverRPC.HandleStreamClose)
}

// AcceptMuxedConn runs a loop which calls Accept on a muxer to handle streams.
//
// Starts HandleStream in a separate goroutine to handle the stream.
// Returns context.Canceled or io.EOF when the loop is complete / closed.
func (s *Server) AcceptMuxedConn(ctx context.Context, mc MuxedConn) error {
	for {
		if err := ctx.Err(); err != nil {
			return context.Canceled
		}

		if mc.IsClosed() {
			return io.EOF
		}

		muxedStream, err := mc.AcceptStream()
		if err != nil {
			return err
		}
		go s.HandleStream(ctx, muxedStream)
	}
}
