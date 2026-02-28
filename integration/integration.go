package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/aperturerobotics/go-websocket"
	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/sirupsen/logrus"
)

func main() {
	mux := srpc.NewMux()
	echoServer := echo.NewEchoServer(mux)
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		logrus.Fatal(err.Error())
	}

	// listen at: ws://localhost:4352/demo
	server, err := srpc.NewHTTPServer(mux, "/demo", &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		logrus.Fatal(err.Error())
	}

	fmt.Print("listening on localhost:4352\n")
	hserver := &http.Server{
		Addr:              "localhost:4352",
		Handler:           server,
		ReadHeaderTimeout: time.Second * 10,
	}
	if err := hserver.ListenAndServe(); err != nil {
		logrus.Fatal(err.Error())
	}
}
