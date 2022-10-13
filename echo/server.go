package echo

import (
	context "context"
	"errors"
	"io"
	"time"

	rpcstream "github.com/aperturerobotics/starpc/rpcstream"
	srpc "github.com/aperturerobotics/starpc/srpc"
	"google.golang.org/protobuf/proto"
)

// EchoServer implements the server side of Echo.
type EchoServer struct {
	rpcStreamMux srpc.Mux
}

// NewEchoServer constructs a EchoServer with a RpcStream mux.
func NewEchoServer(rpcStreamMux srpc.Mux) *EchoServer {
	return &EchoServer{rpcStreamMux: rpcStreamMux}
}

// Register registers the Echo server with the Mux.
func (e *EchoServer) Register(mux srpc.Mux) error {
	return SRPCRegisterEchoer(mux, e)
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

// EchoBidiStream implements SRPCEchoerServer
func (s *EchoServer) EchoBidiStream(strm SRPCEchoer_EchoBidiStreamStream) error {
	// server sends initial message
	if err := strm.MsgSend(&EchoMsg{Body: "hello from server"}); err != nil {
		return err
	}
	for {
		msg, err := strm.Recv()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if len(msg.GetBody()) == 0 {
			return errors.New("got message with empty body")
		}
		if err := strm.Send(msg); err != nil {
			return err
		}
	}
}

// RpcStream runs a rpc stream
func (r *EchoServer) RpcStream(stream SRPCEchoer_RpcStreamStream) error {
	return rpcstream.HandleRpcStream(stream, func(ctx context.Context, componentID string) (srpc.Mux, func(), error) {
		if r.rpcStreamMux == nil {
			return nil, nil, errors.New("not implemented")
		}
		return r.rpcStreamMux, nil, nil
	})
}

// _ is a type assertion
var _ SRPCEchoerServer = ((*EchoServer)(nil))
