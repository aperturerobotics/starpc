package e2e

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	e2e_mock "github.com/aperturerobotics/starpc/e2e/mock"
	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/rpcstream"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/pkg/errors"
)

const bodyTxt = "hello world via starpc e2e test"

// RunE2E runs an end to end test with a callback.
func RunE2E(t *testing.T, cb func(client echo.SRPCEchoerClient) error) {
	RunE2E_Setup(t, func(server *srpc.Server, mux srpc.Mux, client srpc.Client) error {
		// construct the server
		echoServer := echo.NewEchoServer(mux)
		if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
			t.Fatal(err.Error())
		}

		// construct the client rpc interface
		clientEcho := echo.NewSRPCEchoerClient(client)
		return cb(clientEcho)
	})
}

// RunE2E_Setup sets up the client and server and calls the callback.
func RunE2E_Setup(t *testing.T, cb func(server *srpc.Server, mux srpc.Mux, client srpc.Client) error) {
	// Alternatively:
	// openStream := srpc.NewServerPipe(server)
	// client := srpc.NewClient(openStream)
	clientPipe, serverPipe := net.Pipe()

	// outbound=true
	clientMp, err := srpc.NewMuxedConn(clientPipe, true, nil)
	if err != nil {
		t.Fatal(err.Error())
	}
	client := srpc.NewClientWithMuxedConn(clientMp)

	mux := srpc.NewMux()
	server := srpc.NewServer(mux)

	ctx := context.Background()
	// outbound=false
	serverMp, err := srpc.NewMuxedConn(serverPipe, false, nil)
	if err != nil {
		t.Fatal(err.Error())
	}
	go func() {
		_ = server.AcceptMuxedConn(ctx, serverMp)
	}()

	// call
	if err := cb(server, mux, client); err != nil {
		t.Fatal(err.Error())
	}
}

func TestE2E_Unary(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		out, err := client.Echo(ctx, &echo.EchoMsg{
			Body: bodyTxt,
		})
		if err != nil {
			t.Fatal(err.Error())
		}
		if out.GetBody() != bodyTxt {
			t.Fatalf("expected %q got %q", bodyTxt, out.GetBody())
		}
		return nil
	})
}

// CheckServerStream checks the server stream portion of the Echo test.
func CheckServerStream(t *testing.T, out echo.SRPCEchoer_EchoServerStreamClient, req *echo.EchoMsg) error {
	// expect to rx 5, then close
	expectedRx := 5
	totalExpected := expectedRx
	for {
		echoMsg, err := out.Recv()
		if err != nil {
			if err == io.EOF {
				break
			}
			return err
		}
		body := echoMsg.GetBody()
		bodyTxt := req.GetBody()
		if body != bodyTxt {
			return errors.Errorf("expected %q got %q", bodyTxt, body)
		}
		t.Logf("server->client message %d/%d", totalExpected-expectedRx+1, totalExpected)
		expectedRx--
	}
	if expectedRx < 0 {
		return errors.Errorf("got %d more messages than expected", -1*expectedRx)
	}
	return nil
}

func TestE2E_ServerStream(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		req := &echo.EchoMsg{
			Body: bodyTxt,
		}
		out, err := client.EchoServerStream(ctx, req)
		if err != nil {
			t.Fatal(err.Error())
		}
		return CheckServerStream(t, out, req)
	})
}

func TestE2E_Cancel(t *testing.T) {
	rctx := context.Background()
	RunE2E_Setup(t, func(server *srpc.Server, mux srpc.Mux, client srpc.Client) error {
		ctxCh := make(chan context.Context, 1)
		doneCh := make(chan error, 1)
		msrv := &e2e_mock.MockServer{
			MockRequestCb: func(ctx context.Context, msg *e2e_mock.MockMsg) (*e2e_mock.MockMsg, error) {
				ctxCh <- ctx
				<-ctx.Done()
				return nil, context.Canceled
			},
		}
		_ = msrv.Register(mux)

		ctx, ctxCancel := context.WithCancel(rctx)
		mclient := e2e_mock.NewSRPCMockClient(client)
		go func() {
			_, err := mclient.MockRequest(ctx, &e2e_mock.MockMsg{Body: bodyTxt})
			doneCh <- err
		}()

		var reqCtx context.Context
		select {
		case reqCtx = <-ctxCh:
		case <-time.After(time.Millisecond * 100):
			t.FailNow()
		}

		ctxCancel()
		select {
		case <-reqCtx.Done():
		case <-time.After(time.Millisecond * 100):
			t.Fatal("request ctx did not cancel after we canceled client-side ctx")
		}
		select {
		case <-doneCh:
		case <-time.After(time.Millisecond * 100):
			t.Fatal("request did not exit on client side after we canceled ctx")
		}
		return nil
	})
}

// CheckClientStream checks the server stream portion of the Echo test.
func CheckClientStream(t *testing.T, out echo.SRPCEchoer_EchoClientStreamClient, req *echo.EchoMsg) error {
	// send request
	if err := out.MsgSend(req); err != nil {
		return err
	}
	// expect 1 response
	ret := &echo.EchoMsg{}
	if err := out.MsgRecv(ret); err != nil {
		return err
	}
	// check response
	if ret.GetBody() != req.GetBody() {
		return errors.Errorf("expected %q got %q", req.GetBody(), ret.GetBody())
	}
	_ = out.Close()
	return nil
}

func TestE2E_ClientStream(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		bodyTxt := "hello world"
		req := &echo.EchoMsg{
			Body: bodyTxt,
		}
		out, err := client.EchoClientStream(ctx)
		if err != nil {
			t.Fatal(err.Error())
		}
		return CheckClientStream(t, out, req)
	})
}

func TestE2E_BidiStream(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		strm, err := client.EchoBidiStream(ctx)
		if err != nil {
			t.Fatal(err.Error())
		}
		clientExpected := "hello from client"
		if err := strm.MsgSend(&echo.EchoMsg{Body: clientExpected}); err != nil {
			t.Fatal(err.Error())
		}
		msg, err := strm.Recv()
		if err != nil {
			t.Fatal(err.Error())
		}
		expected := "hello from server"
		if msg.GetBody() != expected {
			t.Fatalf("expected %q got %q", expected, msg.GetBody())
		}
		// expect no error closing
		return strm.Close()
	})
}

func TestE2E_RpcStream(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		openStreamFn := rpcstream.NewRpcStreamOpenStream(func(ctx context.Context) (rpcstream.RpcStream, error) {
			return client.RpcStream(ctx)
		}, "test", false)
		proxiedClient := srpc.NewClient(openStreamFn)
		proxiedSvc := echo.NewSRPCEchoerClient(proxiedClient)

		// run a RPC proxied over another RPC
		resp, err := proxiedSvc.Echo(ctx, &echo.EchoMsg{Body: "hello world"})
		if err != nil {
			return err
		}
		if resp.GetBody() != "hello world" {
			return errors.Errorf("response body incorrect: %q", resp.GetBody())
		}

		return nil
	})
}
