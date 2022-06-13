package srpc

import (
	"context"
	"io"
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

// HandleConn handles an incoming ReadWriteCloser.
func (s *Server) HandleConn(ctx context.Context, rwc io.ReadWriteCloser) error {
	subCtx, subCtxCancel := context.WithCancel(ctx)
	defer subCtxCancel()
	serverRPC := NewServerRPC(subCtx, s.mux)
	prw := NewPacketReadWriter(rwc, serverRPC.HandlePacket)
	serverRPC.SetWriter(prw)
	return prw.ReadPump()
}
