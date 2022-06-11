package e2e

import (
	"context"
	"io"
	"testing"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/pkg/errors"
)

// RunE2E runs an end to end test with a callback.
func RunE2E(t *testing.T, cb func(client echo.SRPCEchoerClient) error) {
	// construct the server
	echoServer := &echo.EchoServer{}
	mux := srpc.NewMux()
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		t.Fatal(err.Error())
	}
	server := srpc.NewServer(mux)

	// construct the client
	openStream := srpc.NewServerPipe(server)
	client := srpc.NewClient(openStream)

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
