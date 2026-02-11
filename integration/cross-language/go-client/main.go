package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

const bodyTxt = "hello world via starpc cross-language e2e test"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: go-client <addr>\n")
		os.Exit(1)
	}
	addr := os.Args[1]

	openStream := func(ctx context.Context, msgHandler srpc.PacketDataHandler, closeHandler srpc.CloseHandler) (srpc.PacketWriter, error) {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			return nil, err
		}
		prw := srpc.NewPacketReadWriter(conn)
		go prw.ReadPump(msgHandler, closeHandler)
		return prw, nil
	}

	client := srpc.NewClient(openStream)
	echoClient := echo.NewSRPCEchoerClient(client)
	ctx := context.Background()

	if err := testUnary(ctx, echoClient); err != nil {
		fmt.Fprintf(os.Stderr, "unary test failed: %v\n", err)
		os.Exit(1)
	}

	if err := testServerStream(ctx, echoClient); err != nil {
		fmt.Fprintf(os.Stderr, "server stream test failed: %v\n", err)
		os.Exit(1)
	}

	if err := testClientStream(ctx, echoClient); err != nil {
		fmt.Fprintf(os.Stderr, "client stream test failed: %v\n", err)
		os.Exit(1)
	}

	if err := testBidiStream(ctx, echoClient); err != nil {
		fmt.Fprintf(os.Stderr, "bidi stream test failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("All tests passed.")
}

func testUnary(ctx context.Context, client echo.SRPCEchoerClient) error {
	fmt.Println("Testing Unary RPC...")
	out, err := client.Echo(ctx, &echo.EchoMsg{Body: bodyTxt})
	if err != nil {
		return fmt.Errorf("echo call: %w", err)
	}
	if out.GetBody() != bodyTxt {
		return fmt.Errorf("expected %q got %q", bodyTxt, out.GetBody())
	}
	fmt.Println("  PASSED")
	return nil
}

func testServerStream(ctx context.Context, client echo.SRPCEchoerClient) error {
	fmt.Println("Testing ServerStream RPC...")
	strm, err := client.EchoServerStream(ctx, &echo.EchoMsg{Body: bodyTxt})
	if err != nil {
		return fmt.Errorf("echo server stream call: %w", err)
	}
	received := 0
	for {
		msg, err := strm.Recv()
		if err != nil {
			if err == io.EOF {
				break
			}
			return fmt.Errorf("recv: %w", err)
		}
		if msg.GetBody() != bodyTxt {
			return fmt.Errorf("expected %q got %q", bodyTxt, msg.GetBody())
		}
		received++
	}
	if received != 5 {
		return fmt.Errorf("expected 5 messages, got %d", received)
	}
	fmt.Println("  PASSED")
	return nil
}

func testClientStream(ctx context.Context, client echo.SRPCEchoerClient) error {
	fmt.Println("Testing ClientStream RPC...")
	strm, err := client.EchoClientStream(ctx)
	if err != nil {
		return fmt.Errorf("echo client stream call: %w", err)
	}
	if err := strm.MsgSend(&echo.EchoMsg{Body: bodyTxt}); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	resp := &echo.EchoMsg{}
	if err := strm.MsgRecv(resp); err != nil {
		return fmt.Errorf("recv: %w", err)
	}
	if resp.GetBody() != bodyTxt {
		return fmt.Errorf("expected %q got %q", bodyTxt, resp.GetBody())
	}
	_ = strm.Close()
	fmt.Println("  PASSED")
	return nil
}

func testBidiStream(ctx context.Context, client echo.SRPCEchoerClient) error {
	fmt.Println("Testing BidiStream RPC...")
	strm, err := client.EchoBidiStream(ctx)
	if err != nil {
		return fmt.Errorf("echo bidi stream call: %w", err)
	}

	// server sends initial message
	msg, err := strm.Recv()
	if err != nil {
		return fmt.Errorf("recv initial: %w", err)
	}
	if msg.GetBody() != "hello from server" {
		return fmt.Errorf("expected %q got %q", "hello from server", msg.GetBody())
	}

	// send a message and expect echo
	if err := strm.MsgSend(&echo.EchoMsg{Body: bodyTxt}); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	msg, err = strm.Recv()
	if err != nil {
		return fmt.Errorf("recv echo: %w", err)
	}
	if msg.GetBody() != bodyTxt {
		return fmt.Errorf("expected %q got %q", bodyTxt, msg.GetBody())
	}
	_ = strm.Close()
	fmt.Println("  PASSED")
	return nil
}
