package srpc

import "context"

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

// HandleStream handles an incoming SRPC stream.
// returns & closes the stream once the RPC is complete.
func (s *Server) HandleStream(strm Stream) error {
	rpc := NewServerRPC(strm.Context(), strm, s.mux)
	ctx := rpc.Context()
	defer rpc.Close()
	for {
		msg := &Packet{}
		if err := strm.MsgRecv(msg); err != nil {
			return err
		}
		if err := rpc.HandlePacket(msg); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return context.Canceled
		default:
		}
	}
}
