package srpc_test

import (
	"context"
	"io"
	"net"
	"testing"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
	"github.com/pkg/errors"
)

// endedClient returns each new stream only after its transport has closed, so
// the generated caller half-closes after the remote already ended the call.
type endedClient struct {
	srpc.Client
	// closed is closed after the transport close callback of the one stream
	// this client may open returns.
	closed <-chan struct{}
}

// NewStream opens the stream and waits for its transport to close.
func (c *endedClient) NewStream(
	ctx context.Context,
	service, method string,
	firstMsg srpc.Message,
) (srpc.Stream, error) {
	strm, err := c.Client.NewStream(ctx, service, method, firstMsg)
	if err != nil {
		return nil, err
	}
	<-c.closed
	return strm, nil
}

// onceEchoServer answers a server stream with one message and returns.
type onceEchoServer struct {
	*echo.EchoServer
}

// EchoServerStream sends the request back once and completes the call.
func (onceEchoServer) EchoServerStream(msg *echo.EchoMsg, strm echo.SRPCEchoer_EchoServerStreamStream) error {
	return strm.Send(msg)
}

// newEchoPipe serves impl over an in-memory pipe per stream.
func newEchoPipe(t *testing.T, impl echo.SRPCEchoerServer) srpc.OpenStreamFunc {
	t.Helper()
	mux := srpc.NewMux()
	if err := echo.SRPCRegisterEchoer(mux, impl); err != nil {
		t.Fatal(err)
	}
	return srpc.NewServerPipe(srpc.NewServer(mux))
}

// notifyClose wraps openStream for a single stream and returns a channel
// closed after that stream's transport close callback returns.
func notifyClose(openStream srpc.OpenStreamFunc) (srpc.OpenStreamFunc, <-chan struct{}) {
	closed := make(chan struct{})
	return func(
		ctx context.Context,
		msgHandler srpc.PacketDataHandler,
		closeHandler srpc.CloseHandler,
	) (srpc.PacketWriter, error) {
		return openStream(ctx, msgHandler, func(closeErr error) {
			closeHandler(closeErr)
			close(closed)
		})
	}, closed
}

func TestServerStreamCompletedBeforeCloseSend(t *testing.T) {
	// Complete the server stream before the generated caller half-closes.
	openStream, closed := notifyClose(newEchoPipe(t, onceEchoServer{echo.NewEchoServer(nil)}))
	client := echo.NewSRPCEchoerClient(&endedClient{Client: srpc.NewClient(openStream), closed: closed})
	strm, err := client.EchoServerStream(t.Context(), &echo.EchoMsg{Body: bodyTxt})
	if err != nil {
		t.Fatalf("server stream discarded after remote completion: %v", err)
	}
	t.Cleanup(func() { _ = strm.Close() })

	// Read the buffered response, then the clean completion.
	msg, err := strm.Recv()
	if err != nil {
		t.Fatalf("buffered response lost: %v", err)
	}
	if msg.GetBody() != bodyTxt {
		t.Fatalf("expected %q got %q", bodyTxt, msg.GetBody())
	}
	if _, err := strm.Recv(); err != io.EOF {
		t.Fatalf("expected io.EOF after completion, got %v", err)
	}
}

func TestClientStreamCompletedBeforeCloseSend(t *testing.T) {
	// EchoClientStream replies to the first message without waiting for the
	// half-close, so the call ends while the client may still send.
	openStream, closed := notifyClose(newEchoPipe(t, echo.NewEchoServer(nil)))
	client := echo.NewSRPCEchoerClient(srpc.NewClient(openStream))
	strm, err := client.EchoClientStream(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = strm.Close() })

	// Send the one request and wait for the call to end.
	if err := strm.Send(&echo.EchoMsg{Body: bodyTxt}); err != nil {
		t.Fatal(err)
	}
	<-closed

	// The half-close fails, but the reply is still readable.
	msg, err := strm.CloseAndRecv()
	if err != nil {
		t.Fatalf("buffered reply lost: %v", err)
	}
	if msg.GetBody() != bodyTxt {
		t.Fatalf("expected %q got %q", bodyTxt, msg.GetBody())
	}
}

func TestServerStreamTransportFailureBeforeCloseSend(t *testing.T) {
	// Accept CallStart, then drop the transport without a response.
	openStream, closed := notifyClose(func(
		ctx context.Context,
		msgHandler srpc.PacketDataHandler,
		closeHandler srpc.CloseHandler,
	) (srpc.PacketWriter, error) {
		srvPipe, clientPipe := net.Pipe()
		srvPrw := srpc.NewPacketReadWriter(srvPipe)
		go func() {
			_ = srvPrw.ReadToHandler(func([]byte) error {
				return srvPrw.Close()
			})
		}()
		clientPrw := srpc.NewPacketReadWriter(clientPipe)
		go clientPrw.ReadPump(msgHandler, closeHandler)
		return clientPrw, nil
	})
	client := echo.NewSRPCEchoerClient(&endedClient{Client: srpc.NewClient(openStream), closed: closed})
	strm, err := client.EchoServerStream(t.Context(), &echo.EchoMsg{Body: bodyTxt})
	if err != nil {
		t.Fatalf("server stream discarded after transport failure: %v", err)
	}
	t.Cleanup(func() { _ = strm.Close() })

	// Recv reports that the call ended without a verdict.
	if _, err := strm.Recv(); !errors.Is(err, srpc.ErrClosedBeforeCompletion) {
		t.Fatalf("expected ErrClosedBeforeCompletion, got %v", err)
	}
}
