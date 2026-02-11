package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	mux := srpc.NewMux()
	echoServer := echo.NewEchoServer(mux)
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		fmt.Fprintf(os.Stderr, "register error: %v\n", err)
		os.Exit(1)
	}
	server := srpc.NewServer(mux)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen error: %v\n", err)
		os.Exit(1)
	}
	defer ln.Close()

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
		go server.HandleStream(ctx, conn)
	}
}
