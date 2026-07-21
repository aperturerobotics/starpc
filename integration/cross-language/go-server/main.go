package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	receiptMode := len(os.Args) > 1 && os.Args[1] == "receipt"
	receiptCase := ""
	if receiptMode {
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "usage: go-server receipt <case>")
			os.Exit(1)
		}
		receiptCase = os.Args[2]
		switch receiptCase {
		case "commit", "abort", "loss", "bare-close":
		default:
			fmt.Fprintf(os.Stderr, "unknown receipt case: %s\n", receiptCase)
			os.Exit(1)
		}
	}
	mux := srpc.NewMux()
	echoServer := echo.NewEchoServer(mux)
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		fmt.Fprintf(os.Stderr, "register error: %v\n", err)
		os.Exit(1)
	}
	var receiptDone <-chan struct{}
	var finishReceipt func()
	var receiptCommitted atomic.Bool
	if receiptMode {
		done := make(chan struct{})
		var doneOnce sync.Once
		receiptDone = done
		finishReceipt = func() {
			doneOnce.Do(func() {
				close(done)
			})
		}
	}
	var invoker srpc.Invoker = mux
	if receiptMode {
		invoker = srpc.InvokerFunc(func(
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
			kind, waitErr := invocation.WaitTerminal(context.Background())
			markerErr := emitReceiptEvent(
				fmt.Sprintf("SERVER_RECEIPT_TERMINAL %s", terminalName(kind)),
			)
			if waitErr != nil {
				return true, waitErr
			}
			if markerErr != nil {
				return true, markerErr
			}
			if kind == srpc.TerminalKind_TERMINAL_KIND_COMMITTED {
				receiptCommitted.Store(true)
			}
			if kind != srpc.TerminalKind_TERMINAL_KIND_COMMITTED {
				finishReceipt()
			}
			return true, nil
		})
	}
	server := srpc.NewServer(invoker)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen error: %v\n", err)
		os.Exit(1)
	}
	defer ln.Close()

	if receiptMode {
		go func() {
			<-receiptDone
			_ = ln.Close()
		}()
	}

	fmt.Printf("LISTENING %s\n", ln.Addr().String())

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		var stream net.Conn
		stream = conn
		if receiptMode {
			stream = &receiptConn{
				Conn:          conn,
				finishReceipt: finishReceipt,
				committed:     &receiptCommitted,
			}
		}
		go server.HandleStream(ctx, stream)
	}
}

type receiptConn struct {
	net.Conn
	finishReceipt func()
	committed     *atomic.Bool
	inspect       []byte
	ackPending    bool
}

func (c *receiptConn) Write(p []byte) (int, error) {
	if !c.ackPending {
		if err := c.observeReceiptPackets(p); err != nil {
			return 0, err
		}
	}
	n, err := c.Conn.Write(p)
	if err != nil {
		return n, err
	}
	if c.ackPending && n == len(p) {
		c.finishReceipt()
		c.ackPending = false
	}
	return n, nil
}

func (c *receiptConn) observeReceiptPackets(p []byte) error {
	c.inspect = append(c.inspect, p...)
	for len(c.inspect) >= 4 {
		size := int(binary.LittleEndian.Uint32(c.inspect[:4]))
		if len(c.inspect) < 4+size {
			break
		}
		pkt := &srpc.Packet{}
		if err := pkt.UnmarshalVT(c.inspect[4 : 4+size]); err != nil {
			return err
		}
		c.inspect = c.inspect[4+size:]
		data := pkt.GetCallData()
		if !c.committed.Load() {
			continue
		}
		if data == nil || !data.GetComplete() || data.GetError() != "" {
			continue
		}
		if err := emitReceiptEvent("SERVER_RECEIPT_ACK_WRITE committed"); err != nil {
			return err
		}
		c.ackPending = true
	}
	return nil
}

func terminalName(kind srpc.TerminalKind) string {
	switch kind {
	case srpc.TerminalKind_TERMINAL_KIND_COMMITTED:
		return "committed"
	case srpc.TerminalKind_TERMINAL_KIND_CANCELED:
		return "canceled"
	case srpc.TerminalKind_TERMINAL_KIND_TRANSPORT_LOST:
		return "transportLost"
	case srpc.TerminalKind_TERMINAL_KIND_CLOSED:
		return "closed"
	case srpc.TerminalKind_TERMINAL_KIND_ABANDONED:
		return "abandoned"
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
