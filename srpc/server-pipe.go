package srpc

import (
	"context"
	"net"
)

// NewServerPipe constructs a open stream func which creates an in-memory Pipe
// Stream with the given Server. Starts read pumps for both. Starts the
// HandleStream function on the server in a separate goroutine.
func NewServerPipe(server *Server) OpenStreamFunc {
	return func(ctx context.Context, msgHandler PacketHandler, closeHandler CloseHandler) (Writer, error) {
		srvPipe, clientPipe := net.Pipe()
		go func() {
			_ = server.HandleStream(ctx, srvPipe)
		}()
		clientPrw := NewPacketReadWriter(clientPipe)
		go clientPrw.ReadPump(msgHandler, closeHandler)
		return clientPrw, nil
	}
}
