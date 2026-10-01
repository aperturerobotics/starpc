package srpc_test

import (
	"context"
	"testing"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/pkg/errors"
)

// failingEchoServer fails every unary echo.
type failingEchoServer struct {
	*echo.EchoServer
}

// Echo returns errEchoFailed.
func (failingEchoServer) Echo(context.Context, *echo.EchoMsg) (*echo.EchoMsg, error) {
	return nil, errEchoFailed
}

// errEchoFailed is the error failingEchoServer returns.
var errEchoFailed = errors.New("echo failed")

// TestClientInvokerForwardsResult checks that a proxied call reports the
// remote's reply and the remote handler's error.
func TestClientInvokerForwardsResult(t *testing.T) {
	ctx := t.Context()
	proxy := func(server echo.SRPCEchoerServer) echo.SRPCEchoerClient {
		mux := srpc.NewMux()
		if err := echo.SRPCRegisterEchoer(mux, server); err != nil {
			t.Fatal(err)
		}
		remote := srpc.NewClient(srpc.NewServerPipe(srpc.NewServer(mux)))
		invoker := srpc.NewClientInvoker(remote)
		return echo.NewSRPCEchoerClient(srpc.NewClient(srpc.NewServerPipe(srpc.NewServer(invoker))))
	}

	// A reply passes through unchanged.
	reply, err := proxy(echo.NewEchoServer(nil)).Echo(ctx, &echo.EchoMsg{Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if reply.GetBody() != "hello" {
		t.Errorf("reply body = %q", reply.GetBody())
	}

	// A handler error reaches the caller instead of a cancellation.
	_, err = proxy(failingEchoServer{}).Echo(ctx, &echo.EchoMsg{Body: "hello"})
	if err == nil || err.Error() != errEchoFailed.Error() {
		t.Errorf("proxied error = %v, want %v", err, errEchoFailed)
	}
}
