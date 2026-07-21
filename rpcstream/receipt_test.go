package rpcstream

import (
	"context"
	"errors"
	"net"
	"testing"

	yamux "github.com/libp2p/go-yamux/v4"

	"github.com/aperturerobotics/starpc/srpc"
)

// srpcRpcStream adapts a srpc.Stream carrying RpcStreamPacket messages to the
// RpcStream interface, mirroring the generated tunnel stream wrapper.
type srpcRpcStream struct {
	srpc.Stream
}

// Send sends a RpcStreamPacket to the remote.
func (s srpcRpcStream) Send(pkt *RpcStreamPacket) error {
	return s.MsgSend(pkt)
}

// Recv receives a RpcStreamPacket from the remote.
func (s srpcRpcStream) Recv() (*RpcStreamPacket, error) {
	pkt := new(RpcStreamPacket)
	if err := s.MsgRecv(pkt); err != nil {
		return nil, err
	}
	return pkt, nil
}

// _ is a type assertion.
var _ RpcStream = srpcRpcStream{}

// newReceiptHoldInvoker returns an invoker that delegates to a unary handler,
// then synchronously holds the same invocation on WaitTerminal until the client
// terminal.
func newReceiptHoldInvoker(terminalCh chan<- srpc.TerminalKind) srpc.Invoker {
	// generated unary handler: read the request, send the single response,
	// then return without completing the stream.
	generated := srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
		req := srpc.NewRawMessage(nil, true)
		if err := strm.MsgRecv(req); err != nil {
			return true, err
		}
		if err := strm.MsgSend(srpc.NewRawMessage([]byte("held-response"), false)); err != nil {
			return true, err
		}
		return true, nil
	})
	return srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
		handled, err := generated.InvokeMethod(serviceID, methodID, strm)
		if err != nil || !handled {
			return handled, err
		}
		invocation, ok := srpc.GetServerInvocation(strm.Context())
		if !ok {
			return true, errors.New("missing server invocation")
		}
		kind, werr := invocation.WaitTerminal(context.Background())
		if werr == nil {
			terminalCh <- kind
		}
		return true, werr
	})
}

// runReceiptHeldResponse drives an ExecCallReceipt through the outer RpcStream
// tunnel exposed by rpcClient and asserts that the first inner response is
// client-visible while the exact inner invocation stays open for commit.
func runReceiptHeldResponse(t *testing.T, rpcClient srpc.Client, terminalCh <-chan srpc.TerminalKind) {
	t.Helper()
	out := srpc.NewRawMessage(nil, true)
	receipt, err := srpc.ExecCallReceipt(
		context.Background(), rpcClient, "test.Service", "Do",
		srpc.NewRawMessage([]byte("request"), false), out,
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}

	// The first inner response must be client-visible while the inner
	// invocation stays open in WaitTerminal.
	if got := string(out.GetData()); got != "held-response" {
		t.Fatalf("response body = %q, want held-response", got)
	}
	select {
	case kind := <-terminalCh:
		t.Fatalf("inner invocation reached terminal %v before commit", kind)
	default:
	}

	if err := receipt.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	select {
	case kind := <-terminalCh:
		if kind != srpc.TerminalKind_TERMINAL_KIND_COMMITTED {
			t.Fatalf("terminal = %v, want committed", kind)
		}
	case <-timeAfterTestTimeout():
		t.Fatal("inner invocation did not observe commit terminal")
	}
}

// TestHandleRpcStreamReceiptHeldResponseMemory reproduces the nested receipt
// tunnel over an in-memory RpcStream pair (no outer srpc layer).
func TestHandleRpcStreamReceiptHeldResponseMemory(t *testing.T) {
	clientStream, serverStream := newMemoryRpcStreamPair(t)

	terminalCh := make(chan srpc.TerminalKind, 1)
	invoker := newReceiptHoldInvoker(terminalCh)

	serverDone := make(chan error, 1)
	go func() {
		serverDone <- HandleRpcStream(serverStream, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			return invoker, nil, nil
		})
	}()

	rpcClient := NewRpcStreamClient(func(ctx context.Context) (RpcStream, error) {
		return clientStream, nil
	}, "component-a", true)

	runReceiptHeldResponse(t, rpcClient, terminalCh)
	requireHandleRpcStreamDone(t, serverDone, nil)
}

// TestHandleRpcStreamReceiptHeldResponseTunnel reproduces the nested receipt
// tunnel over a real outer srpc streaming call. The outer method runs
// HandleRpcStream and stays in its read pumps while the inner invocation holds
// in WaitTerminal.
func TestHandleRpcStreamReceiptHeldResponseTunnel(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	clientMux, err := srpc.NewMuxedConn(clientConn, true, nil)
	if err != nil {
		t.Fatalf("client mux: %v", err)
	}
	serverMux, err := srpc.NewMuxedConn(serverConn, false, nil)
	if err != nil {
		_ = clientMux.Close()
		t.Fatalf("server mux: %v", err)
	}

	terminalCh := make(chan srpc.TerminalKind, 1)
	inner := newReceiptHoldInvoker(terminalCh)

	// outer streaming method runs HandleRpcStream over its typed stream.
	outer := srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
		return true, HandleRpcStream(srpcRpcStream{strm}, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			return inner, nil, nil
		})
	})

	server := srpc.NewServer(outer)
	serverCtx, serverCancel := context.WithCancel(context.Background())
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.AcceptMuxedConn(serverCtx, serverMux)
	}()
	t.Cleanup(func() {
		if err := serverMux.Close(); err != nil {
			t.Errorf("close server mux: %v", err)
		}
		acceptErr := <-serverErr
		serverCancel()
		if acceptErr != yamux.ErrSessionShutdown {
			t.Errorf("server accept: %v, want session shutdown", acceptErr)
		}
		if err := clientMux.Close(); err != nil {
			t.Errorf("close client mux: %v", err)
		}
	})

	client := srpc.NewClientWithMuxedConn(clientMux)
	rpcClient := NewRpcStreamClient(func(ctx context.Context) (RpcStream, error) {
		strm, err := client.NewStream(ctx, "test.Outer", "RpcStream", nil)
		if err != nil {
			return nil, err
		}
		return srpcRpcStream{strm}, nil
	}, "component-a", true)

	runReceiptHeldResponse(t, rpcClient, terminalCh)
}
