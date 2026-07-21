package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sync"

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
			if kind != srpc.TerminalCommitted {
				finishReceipt()
			}
			return true, nil
		})
	}
	var server *srpc.Server
	if !receiptMode {
		server = srpc.NewServer(invoker)
	}
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
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		if receiptMode {
			go handleReceiptStream(ctx, conn, invoker, finishReceipt)
		} else {
			go server.HandleStream(ctx, conn)
		}
	}
}

func handleReceiptStream(
	ctx context.Context,
	conn net.Conn,
	invoker srpc.Invoker,
	finishReceipt func(),
) {
	prw := srpc.NewPacketReadWriter(conn)
	writer := &receiptPacketWriter{
		inner:         prw,
		finishReceipt: finishReceipt,
	}
	rpc := srpc.NewServerRPC(ctx, invoker, writer)
	prw.ReadPump(rpc.HandlePacketData, rpc.HandleStreamClose)
}

type receiptPacketWriter struct {
	inner         srpc.PacketWriter
	finishReceipt func()
}

func (w *receiptPacketWriter) WritePacket(pkt *srpc.Packet) error {
	if err := w.inner.WritePacket(pkt); err != nil {
		return err
	}
	data := pkt.GetCallData()
	if data != nil && data.GetComplete() && data.GetError() == "" {
		if err := emitReceiptEvent("SERVER_RECEIPT_ACK committed"); err != nil {
			return err
		}
		w.finishReceipt()
	}
	return nil
}

func (w *receiptPacketWriter) Close() error {
	return w.inner.Close()
}

func terminalName(kind srpc.TerminalKind) string {
	switch kind {
	case srpc.TerminalCommitted:
		return "committed"
	case srpc.TerminalCanceled:
		return "canceled"
	case srpc.TerminalLost:
		return "transportLost"
	case srpc.TerminalClosed:
		return "closed"
	case srpc.TerminalAbandoned:
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
