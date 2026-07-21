package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

const bodyTxt = "hello world via starpc cross-language e2e test"

func main() {
	receiptMode := len(os.Args) > 1 && os.Args[1] == "receipt"
	receiptCase := ""
	addrIndex := 1
	if receiptMode {
		if len(os.Args) < 3 {
			fmt.Fprintf(os.Stderr, "usage: go-client receipt <case> <addr>\n")
			os.Exit(1)
		}
		receiptCase = os.Args[2]
		addrIndex = 3
		switch receiptCase {
		case "commit", "abort", "loss", "bare-close":
		default:
			fmt.Fprintf(os.Stderr, "unknown receipt case: %s\n", receiptCase)
			os.Exit(1)
		}
	}
	if len(os.Args) <= addrIndex {
		fmt.Fprintf(os.Stderr, "usage: go-client [receipt <case>] <addr>\n")
		os.Exit(1)
	}
	addr := os.Args[addrIndex]
	var conn net.Conn
	openStream := func(ctx context.Context, msgHandler srpc.PacketDataHandler, closeHandler srpc.CloseHandler) (srpc.PacketWriter, error) {
		var err error
		conn, err = net.Dial("tcp", addr) //nolint:gosec
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
	if receiptMode {
		if err := testReceipt(ctx, client, &conn, receiptCase); err != nil {
			fmt.Fprintf(os.Stderr, "receipt test failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("All tests passed.")
		return
	}

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

func testReceipt(
	ctx context.Context,
	client srpc.Client,
	conn *net.Conn,
	receiptCase string,
) error {
	fmt.Printf("Testing held unary receipt (%s)...\n", receiptCase)
	out := new(echo.EchoMsg)
	receipt, err := srpc.ExecCallReceipt(
		ctx, client, echo.SRPCEchoerServiceID, "Echo",
		&echo.EchoMsg{Body: bodyTxt}, out,
	)
	if err != nil {
		return fmt.Errorf("receipt call: %w", err)
	}
	if out.GetBody() != bodyTxt {
		return fmt.Errorf("expected %q got %q", bodyTxt, out.GetBody())
	}

	switch receiptCase {
	case "commit":
		if err := receipt.Commit(); err != nil {
			return fmt.Errorf("receipt commit: %w", err)
		}
	case "abort":
		if err := receipt.Abort(); err != nil {
			return fmt.Errorf("receipt abort: %w", err)
		}
	case "loss":
		if *conn == nil {
			return errors.New("receipt connection is nil")
		}
		tcpConn, ok := (*conn).(*net.TCPConn)
		if !ok {
			return errors.New("receipt connection is not TCP")
		}
		if err := tcpConn.SetLinger(0); err != nil {
			return fmt.Errorf("set receipt loss linger: %w", err)
		}
		if err := tcpConn.Close(); err != nil {
			return fmt.Errorf("close lost connection: %w", err)
		}
		if err := receipt.Commit(); err == nil {
			return errors.New("loss receipt commit unexpectedly succeeded")
		}
	case "bare-close":
		if *conn == nil {
			return errors.New("receipt connection is nil")
		}
		tcpConn, ok := (*conn).(*net.TCPConn)
		if !ok {
			return errors.New("receipt connection is not TCP")
		}
		if err := tcpConn.CloseWrite(); err != nil {
			return fmt.Errorf("close receipt write side: %w", err)
		}
		if err := receipt.Commit(); err == nil {
			return errors.New("bare-close receipt commit unexpectedly succeeded")
		}
	default:
		return fmt.Errorf("unknown receipt case: %s", receiptCase)
	}

	if err := emitReceiptEvent(
		fmt.Sprintf("CLIENT_RECEIPT_RESOLVED %s", receiptTerminalName(receiptCase)),
	); err != nil {
		return fmt.Errorf("record receipt resolution: %w", err)
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

func receiptTerminalName(receiptCase string) string {
	switch receiptCase {
	case "commit":
		return "committed"
	case "abort":
		return "canceled"
	case "loss":
		return "transportLost"
	case "bare-close":
		return "closed"
	default:
		return "unknown"
	}
}

func emitReceiptEvent(line string) error {
	fmt.Println(line)
	fifo := os.Getenv("RECEIPT_EVENT_FIFO")
	if fifo == "" {
		return nil
	}
	file, err := os.OpenFile(fifo, os.O_WRONLY, 0) //nolint:gosec // FIFO path is created by the local integration runner.
	if err != nil {
		return err
	}
	if _, err := file.WriteString(line + "\n"); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
