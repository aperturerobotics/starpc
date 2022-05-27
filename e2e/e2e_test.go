package e2e

import (
	"context"
	"testing"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

// TestE2E tests starpc end to end in-memory.
func TestE2E(t *testing.T) {
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
	ctx := context.Background()
	bodyTxt := "hello world"
	out, err := clientEcho.Echo(ctx, &echo.EchoMsg{
		Body: bodyTxt,
	})
	if err != nil {
		t.Fatal(err.Error())
	}
	if out.GetBody() != bodyTxt {
		t.Fatalf("expected %q got %q", bodyTxt, out.GetBody())
	}
}
