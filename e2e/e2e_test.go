package e2e

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/rpcstream"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/libp2p/go-libp2p/p2p/muxer/mplex"
	mp "github.com/libp2p/go-mplex"
	"github.com/pkg/errors"
)

// RunE2E runs an end to end test with a callback.
func RunE2E(t *testing.T, cb func(client echo.SRPCEchoerClient) error) {
	// construct the server
	mux := srpc.NewMux()
	echoServer := echo.NewEchoServer(mux)
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		t.Fatal(err.Error())
	}
	server := srpc.NewServer(mux)

	// note: also possible to do without mplex:
	// openStream := srpc.NewServerPipe(server)
	// client := srpc.NewClient(openStream)

	// construct the client
	clientPipe, serverPipe := net.Pipe()

	clientMp, err := mp.NewMultiplex(clientPipe, false, nil)
	if err != nil {
		t.Fatal(err.Error())
	}
	client := srpc.NewClientWithMuxedConn(mplex.NewMuxedConn(clientMp))

	ctx := context.Background()
	serverMp, _ := mp.NewMultiplex(serverPipe, true, nil)
	go func() {
		_ = server.AcceptMuxedConn(ctx, mplex.NewMuxedConn(serverMp))
	}()

	// TODO: requires a moment for the listener to start: not sure why.
	// the packets /should/ be buffered in the pipe.
	<-time.After(time.Millisecond * 100)

	// construct the client rpc interface
	clientEcho := echo.NewSRPCEchoerClient(client)

	// call
	if err := cb(clientEcho); err != nil {
		t.Fatal(err.Error())
	}
}

func TestE2E_Unary(t *testing.T) {
	ctx := context.Background()
	RunE2E(t, func(client echo.SRPCEchoerClient) error {
		bodyTxt := "hello world"
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
		bodyTxt := "hello world"
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
		msg, err = strm.Recv()
		if err != nil {
			t.Fatal(err.Error())
		}
		if msg.GetBody() != clientExpected {
			t.Fatalf("expected %q got %q", clientExpected, msg.GetBody())
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
		}, "test")
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
