package srpc

import "context"

// NewServerPipe constructs a open stream func which creates an in-memory Pipe
// Stream with the given Server. Starts read pumps for both. Starts the
// HandleStream function on the server in a separate goroutine.
func NewServerPipe(server *Server) OpenStreamFunc {
	return func(ctx context.Context, msgHandler func(pkt *Packet) error) (Writer, error) {
		clientStream, serverStream := NewPipeStream(ctx)
		go func() {
			_ = server.HandleStream(serverStream)
		}()
		go func() {
			defer serverStream.Close()
			for {
				msg := &Packet{}
				err := clientStream.MsgRecv(msg)
				if err != nil {
					return
				}
				if err := msgHandler(msg); err != nil {
					return
				}
			}
		}()
		return clientStream, nil
	}
}
