package echo

import (
	context "context"

	"google.golang.org/protobuf/proto"
)

// EchoServer implements the server side of Echo.
type EchoServer struct {
}

// Echo implements echo.SRPCEchoerServer
func (*EchoServer) Echo(ctx context.Context, msg *EchoMsg) (*EchoMsg, error) {
	return proto.Clone(msg).(*EchoMsg), nil
}

// _ is a type assertion
var _ SRPCEchoerServer = ((*EchoServer)(nil))
