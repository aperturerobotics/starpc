package echo

import (
	context "context"
	"time"

	"google.golang.org/protobuf/proto"
)

// EchoServer implements the server side of Echo.
type EchoServer struct {
}

// Echo implements echo.SRPCEchoerServer
func (*EchoServer) Echo(ctx context.Context, msg *EchoMsg) (*EchoMsg, error) {
	return proto.Clone(msg).(*EchoMsg), nil
}

// EchoServerStream implements SRPCEchoerServer
func (*EchoServer) EchoServerStream(msg *EchoMsg, strm SRPCEchoer_EchoServerStreamStream) error {
	// send 5 responses, with a 200ms delay for each
	responses := 5
	tkr := time.NewTicker(time.Millisecond * 200)
	defer tkr.Stop()
	for i := 0; i < responses; i++ {
		if err := strm.MsgSend(msg); err != nil {
			return err
		}
		select {
		case <-strm.Context().Done():
			return context.Canceled
		case <-tkr.C:
		}
	}
	return nil
}

// EchoClientStream implements SRPCEchoerServer
func (*EchoServer) EchoClientStream(strm SRPCEchoer_EchoClientStreamStream) error {
	msg, err := strm.Recv()
	if err != nil {
		return err
	}
	return strm.SendAndClose(msg)
}

// _ is a type assertion
var _ SRPCEchoerServer = ((*EchoServer)(nil))
