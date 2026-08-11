package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strings"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/rpcstream"
	"github.com/aperturerobotics/starpc/srpc"
)

const bodyTxt = "hello world via starpc cross-language e2e test"

func main() {
	nested := len(os.Args) >= 3 && os.Args[1] == "--nested"
	nestedRelease := len(os.Args) >= 3 && os.Args[1] == "--nested-release"
	if len(os.Args) != 2 && !nested && !nestedRelease {
		fmt.Fprintf(os.Stderr, "usage: go-client [--nested] <addr>\n")
		os.Exit(1)
	}
	addr := os.Args[len(os.Args)-1]
	openStream := func(ctx context.Context, msgHandler srpc.PacketDataHandler, closeHandler srpc.CloseHandler) (srpc.PacketWriter, error) {
		conn, err := net.Dial("tcp", addr) //nolint:gosec
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
	if nested || nestedRelease {
		if err := testNested(ctx, echoClient, nestedRelease); err != nil {
			fmt.Fprintf(os.Stderr, "nested lifecycle test failed: %v\n", err)
			os.Exit(1)
		}
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

func testNested(ctx context.Context, parent echo.SRPCEchoerClient, release bool) error {
	proxy := rpcstream.NewRpcStreamClient(parent.RpcStream, "test", true)
	if err := testUnary(ctx, echo.NewSRPCEchoerClient(proxy)); err != nil {
		return fmt.Errorf("nested unary: %w", err)
	}

	if release {
		missing := rpcstream.NewRpcStreamClient(parent.RpcStream, "missing", true)
		var missingOut echo.EchoMsg
		if err := missing.ExecCall(ctx, "echo.Echoer", "Echo", &echo.EchoMsg{}, &missingOut); err == nil || !strings.Contains(err.Error(), "unknown component: missing") {
			return fmt.Errorf("unknown component returned wrong result: %v", err)
		}
	}

	stream, err := proxy.NewStream(ctx, "echo.Echoer", "EchoBidiStream", nil)
	if err != nil {
		return fmt.Errorf("nested bidi: %w", err)
	}
	if err := stream.MsgSend(&echo.EchoMsg{Body: "nested later data"}); err != nil {
		return fmt.Errorf("nested later data: %w", err)
	}
	if err := stream.Close(); err != nil {
		return fmt.Errorf("nested cancel: %w", err)
	}

	var terminal echo.EchoMsg
	if err := proxy.ExecCall(ctx, "missing.Service", "Missing", &echo.EchoMsg{}, &terminal); err == nil || !strings.Contains(err.Error(), "missing.Service") {
		return fmt.Errorf("unknown nested method returned wrong result: %v", err)
	}

	if release {
		var terminalError echo.EchoMsg
		if err := proxy.ExecCall(ctx, "echo.Echoer", "Echo", &echo.EchoMsg{Body: "__nested_error__"}, &terminalError); err == nil || !strings.Contains(err.Error(), "nested terminal error") {
			return fmt.Errorf("terminal nested error returned wrong result: %v", err)
		}
	}

	if release {
		releaseClient := rpcstream.NewRpcStreamClient(parent.RpcStream, "release", true)
		var released echo.EchoMsg
		err := releaseClient.ExecCall(ctx, "echo.Echoer", "Echo", &echo.EchoMsg{Body: "__nested_release__"}, &released)
		if err == nil || (!strings.Contains(err.Error(), "stream closed before the remote reported completion") && !strings.Contains(err.Error(), "EOF") && !strings.Contains(err.Error(), "canceled")) {
			return fmt.Errorf("release during active call returned wrong result: %v", err)
		}
		status, err := parent.Echo(ctx, &echo.EchoMsg{Body: "__nested_release_status__"})
		if err != nil {
			return fmt.Errorf("release completion status failed: %w", err)
		}
		if status.GetBody() != "released" {
			return fmt.Errorf("release completion returned %q", status.GetBody())
		}
		if err := releaseClient.ExecCall(ctx, "echo.Echoer", "Echo", &echo.EchoMsg{}, &released); err == nil || !strings.Contains(err.Error(), "unknown component: release") {
			return fmt.Errorf("released component returned wrong result: %v", err)
		}
	}

	direct, err := rpcstream.OpenRpcStream(ctx, parent.RpcStream, "test", true)
	if err != nil {
		return fmt.Errorf("nested direct open: %w", err)
	}
	if err := direct.Close(); err != nil {
		return fmt.Errorf("nested abrupt close: %w", err)
	}
	return nil
}
