package srpc_test

import (
	"context"
	"net"
	"testing"

	yamux "github.com/libp2p/go-yamux/v4"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

type receiptEchoServer struct {
	echo.SRPCEchoerServer
	invocationFound chan bool
}

func (s *receiptEchoServer) Echo(
	ctx context.Context,
	msg *echo.EchoMsg,
) (*echo.EchoMsg, error) {
	_, found := srpc.GetServerInvocation(ctx)
	s.invocationFound <- found
	return msg.CloneVT(), nil
}

func TestCallReceiptGoGo(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	clientMux, err := srpc.NewMuxedConn(clientConn, true, nil)
	if err != nil {
		t.Fatalf("client mux: %v", err)
	}
	serverMux, err := srpc.NewMuxedConn(serverConn, false, nil)
	if err != nil {
		_ = clientMux.Close()
		t.Fatalf("server mux: %v", err)
	}

	mux := srpc.NewMux()
	echoServer := &receiptEchoServer{
		SRPCEchoerServer: echo.NewEchoServer(mux),
		invocationFound:  make(chan bool, 1),
	}
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		t.Fatalf("register echo: %v", err)
	}

	terminal := make(chan srpc.TerminalKind, 1)
	invoker := srpc.InvokerFunc(func(
		serviceID, methodID string,
		strm srpc.Stream,
	) (bool, error) {
		handled, err := mux.InvokeMethod(serviceID, methodID, strm)
		if err != nil || !handled {
			return handled, err
		}
		invocation, ok := srpc.GetServerInvocation(strm.Context())
		if !ok {
			return true, context.Canceled
		}
		kind, err := invocation.WaitTerminal(context.Background())
		if err == nil {
			terminal <- kind
		}
		return true, err
	})
	server := srpc.NewServer(invoker)
	serverCtx, serverCancel := context.WithCancel(context.Background())
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.AcceptMuxedConn(serverCtx, serverMux)
	}()
	t.Cleanup(func() {
		if err := serverMux.Close(); err != nil {
			t.Errorf("close server mux: %v", err)
		}
		acceptErr := <-serverErr
		serverCancel()
		if acceptErr != yamux.ErrSessionShutdown {
			t.Errorf("server accept: %v, want session shutdown", acceptErr)
		}
		if err := clientMux.Close(); err != nil {
			t.Errorf("close client mux: %v", err)
		}
	})

	client := srpc.NewClientWithMuxedConn(clientMux)
	out := new(echo.EchoMsg)
	receipt, err := srpc.ExecCallReceipt(
		context.Background(), client, echo.SRPCEchoerServiceID, "Echo",
		&echo.EchoMsg{Body: "held"}, out,
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}
	if err := receipt.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if out.GetBody() != "held" {
		t.Fatalf("response body = %q, want held", out.GetBody())
	}
	found := <-echoServer.invocationFound
	if !found {
		t.Fatal("generated handler context lost server invocation")
	}
	kind := <-terminal
	if kind != srpc.TerminalCommitted {
		t.Fatalf("terminal = %v, want committed", kind)
	}
}
