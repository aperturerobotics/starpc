package srpc

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

type receiptTestStream struct {
	ctx          context.Context
	recvCount    atomic.Int32
	ack          <-chan error
	ackErr       error
	terminal     TerminalKind
	terminalOkay bool
	closeSend    atomic.Int32
	closeCount   atomic.Int32
	closeErr     error
	serviceSeen  string
}

func (s *receiptTestStream) Context() context.Context {
	return s.ctx
}

func (s *receiptTestStream) MsgSend(Message) error {
	return nil
}

func (s *receiptTestStream) MsgRecv(msg Message) error {
	if s.recvCount.Add(1) == 1 {
		return msg.UnmarshalVT([]byte("response"))
	}
	if s.ack != nil {
		return <-s.ack
	}
	return s.ackErr
}

func (s *receiptTestStream) CloseSend() error {
	s.closeSend.Add(1)
	return nil
}

func (s *receiptTestStream) Close() error {
	s.closeCount.Add(1)
	return s.closeErr
}

func (s *receiptTestStream) receiptTerminalKind() (TerminalKind, bool) {
	return s.terminal, s.terminalOkay
}

type receiptTestClient struct {
	stream *receiptTestStream
}

func (c *receiptTestClient) ExecCall(context.Context, string, string, Message, Message) error {
	return nil
}

func (c *receiptTestClient) NewStream(
	_ context.Context,
	service, _ string,
	_ Message,
) (Stream, error) {
	c.stream.serviceSeen = service
	return c.stream, nil
}

func TestCallReceiptCommitWaitsForServerAcknowledgment(t *testing.T) {
	ack := make(chan error, 1)
	stream := &receiptTestStream{ctx: context.Background(), ack: ack}
	client := &receiptTestClient{stream: stream}
	out := NewRawMessage(nil, true)
	receipt, err := ExecCallReceipt(
		context.Background(), client, "service", "method", NewRawMessage(nil, true), out,
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}

	commitDone := make(chan error, 1)
	go func() { commitDone <- receipt.Commit() }()
	select {
	case err := <-commitDone:
		t.Fatalf("commit returned before acknowledgment: %v", err)
	case <-time.After(time.Millisecond):
	}
	if got := stream.closeSend.Load(); got != 1 {
		t.Fatalf("close send count = %d, want 1", got)
	}

	stream.terminal = TerminalKind_TERMINAL_KIND_COMMITTED
	stream.terminalOkay = true
	ack <- io.EOF
	select {
	case err := <-commitDone:
		if err != nil {
			t.Fatalf("commit: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("commit did not return after acknowledgment")
	}
	if got := stream.closeCount.Load(); got != 1 {
		t.Fatalf("cleanup close count = %d, want 1", got)
	}
}

func TestCallReceiptRejectsBareCloseAfterCloseSend(t *testing.T) {
	stream := &receiptTestStream{
		ctx:          context.Background(),
		ackErr:       io.EOF,
		terminal:     TerminalKind_TERMINAL_KIND_CLOSED,
		terminalOkay: true,
	}
	receipt, err := ExecCallReceipt(
		context.Background(), &receiptTestClient{stream: stream},
		"service", "method", NewRawMessage(nil, true), NewRawMessage(nil, true),
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}
	if err := receipt.Commit(); err == nil {
		t.Fatal("commit accepted bare close after CloseSend")
	}
	if got := stream.closeSend.Load(); got != 1 {
		t.Fatalf("close send count = %d, want 1", got)
	}
}

func TestCallReceiptCommitIgnoresCleanupError(t *testing.T) {
	stream := &receiptTestStream{
		ctx:          context.Background(),
		ackErr:       io.EOF,
		terminal:     TerminalKind_TERMINAL_KIND_COMMITTED,
		terminalOkay: true,
		closeErr:     ErrCompleted,
	}
	receipt, err := ExecCallReceipt(
		context.Background(), &receiptTestClient{stream: stream},
		"service", "method", NewRawMessage(nil, true), NewRawMessage(nil, true),
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}
	if err := receipt.Commit(); err != nil {
		t.Fatalf("commit = %v, want nil", err)
	}
	if got := stream.closeSend.Load(); got != 1 {
		t.Fatalf("close send count = %d, want 1", got)
	}
}

func TestCallReceiptCommitRejectsTrailingResponse(t *testing.T) {
	stream := &receiptTestStream{ctx: context.Background()}
	receipt, err := ExecCallReceipt(
		context.Background(), &receiptTestClient{stream: stream},
		"service", "method", NewRawMessage(nil, true), NewRawMessage(nil, true),
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}
	if err := receipt.Commit(); err == nil {
		t.Fatal("commit accepted trailing response data")
	}
}

func TestCallReceiptCommitReturnsAcknowledgmentError(t *testing.T) {
	ackErr := errors.New("ack transport loss")
	stream := &receiptTestStream{
		ctx:    context.Background(),
		ackErr: ackErr,
	}
	receipt, err := ExecCallReceipt(
		context.Background(), &receiptTestClient{stream: stream},
		"service", "method", NewRawMessage(nil, true), NewRawMessage(nil, true),
	)
	if err != nil {
		t.Fatalf("exec receipt: %v", err)
	}
	if err := receipt.Commit(); !errors.Is(err, ackErr) {
		t.Fatalf("commit error = %v, want %v", err, ackErr)
	}
}

func TestCallReceiptCommitAbortExclusion(t *testing.T) {
	for range 100 {
		stream := &receiptTestStream{
			ctx:          context.Background(),
			ackErr:       io.EOF,
			terminal:     TerminalKind_TERMINAL_KIND_COMMITTED,
			terminalOkay: true,
		}
		receipt, err := ExecCallReceipt(
			context.Background(), &receiptTestClient{stream: stream},
			"service", "method", NewRawMessage(nil, true), NewRawMessage(nil, true),
		)
		if err != nil {
			t.Fatalf("exec receipt: %v", err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = receipt.Commit()
		}()
		go func() {
			defer wg.Done()
			_ = receipt.Abort()
		}()
		wg.Wait()
		if got := stream.closeCount.Load(); got != 1 {
			t.Fatalf("cleanup close count = %d, want 1", got)
		}
		if got := stream.closeSend.Load(); got > 1 {
			t.Fatalf("close send count = %d, want at most 1", got)
		}
	}
}

func TestExecCallReceiptPreservesNewStreamWrappers(t *testing.T) {
	log := logrus.New()
	cases := []struct {
		name     string
		client   Client
		service  string
		expected string
	}{
		{
			name:     "prefix",
			client:   NewPrefixClient(newReceiptClient(), []string{"prefix/"}),
			service:  "prefix/service",
			expected: "service",
		},
		{
			name:     "set",
			client:   NewClientSet([]Client{newReceiptClient()}),
			service:  "service",
			expected: "service",
		},
		{
			name:     "verbose",
			client:   NewVClient(newReceiptClient(), logrus.NewEntry(log)),
			service:  "service",
			expected: "service",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := NewRawMessage(nil, true)
			receipt, err := ExecCallReceipt(
				context.Background(), tc.client, tc.service, "method",
				NewRawMessage(nil, true), out,
			)
			if err != nil {
				t.Fatalf("exec receipt: %v", err)
			}
			if err := receipt.Abort(); err != nil {
				t.Fatalf("abort: %v", err)
			}
			var stream *receiptTestStream
			switch client := tc.client.(type) {
			case *PrefixClient:
				stream = client.client.(*receiptTestClient).stream
			case *ClientSet:
				stream = client.clients[0].(*receiptTestClient).stream
			case *VClient:
				stream = client.client.(*receiptTestClient).stream
			}
			if stream.serviceSeen != tc.expected {
				t.Fatalf("service = %q, want %q", stream.serviceSeen, tc.expected)
			}
		})
	}
}

func newReceiptClient() *receiptTestClient {
	return &receiptTestClient{
		stream: &receiptTestStream{
			ctx:          context.Background(),
			ackErr:       io.EOF,
			terminal:     TerminalKind_TERMINAL_KIND_COMMITTED,
			terminalOkay: true,
		},
	}
}

func TestServerInvocationTerminalClassification(t *testing.T) {
	cases := []struct {
		name string
		act  func(*ServerRPC)
		want TerminalKind
	}{
		{
			name: "explicit complete",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallData(NewCallDataPacket(nil, false, true, nil).GetCallData()); err != nil {
					t.Fatalf("handle complete: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_COMMITTED,
		},
		{
			name: "cancel",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallCancel(); err != nil {
					t.Fatalf("handle cancel: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_CANCELED,
		},
		{
			name: "loss",
			act: func(rpc *ServerRPC) {
				rpc.HandleStreamClose(errors.New("transport loss"))
			},
			want: TerminalKind_TERMINAL_KIND_TRANSPORT_LOST,
		},

		{
			name: "context canceled transport close",
			act: func(rpc *ServerRPC) {
				rpc.HandleStreamClose(context.Canceled)
			},
			want: TerminalKind_TERMINAL_KIND_TRANSPORT_LOST,
		},
		{
			name: "remote error packet",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallData(&CallData{Error: "remote error"}); err != nil {
					t.Fatalf("handle remote error: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_TRANSPORT_LOST,
		},
		{
			name: "remote error completion packet",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallData(&CallData{
					Complete: true,
					Error:    "remote error",
				}); err != nil {
					t.Fatalf("handle remote error completion: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_TRANSPORT_LOST,
		},

		{
			name: "bare close",
			act: func(rpc *ServerRPC) {
				rpc.HandleStreamClose(nil)
			},
			want: TerminalKind_TERMINAL_KIND_CLOSED,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rpc := NewServerRPC(context.Background(), nil, &closeCountingPacketWriter{})
			result := make(chan TerminalKind, 1)
			go func() {
				kind, err := rpc.WaitTerminal(context.Background())
				if err != nil {
					t.Errorf("wait terminal: %v", err)
				}
				result <- kind
			}()
			tc.act(rpc)
			select {
			case got := <-result:
				if got != tc.want {
					t.Fatalf("terminal = %v, want %v", got, tc.want)
				}
			case <-time.After(time.Second):
				t.Fatal("wait terminal did not return")
			}
			if tc.name == "bare close" && rpc.remoteCompleted {
				t.Fatal("bare close marked remote completion")
			}
			if tc.name == "explicit complete" && !rpc.remoteCompleted {
				t.Fatal("explicit completion did not mark remote completion")
			}
			if tc.name == "remote error packet" && rpc.remoteCompleted {
				t.Fatal("remote error packet marked remote completion")
			}
			if tc.name == "remote error completion packet" && rpc.remoteCompleted {
				t.Fatal("remote error completion packet marked remote completion")
			}
		})
	}
}

func TestServerInvocationTerminalIsMonotonic(t *testing.T) {
	cases := []struct {
		name string
		act  func(*ServerRPC)
	}{
		{
			name: "completion then transport loss",
			act: func(rpc *ServerRPC) {
				_ = rpc.HandleCallData(
					NewCallDataPacket(nil, false, true, nil).GetCallData(),
				)
				rpc.HandleStreamClose(errors.New("transport loss"))
			},
		},
		{
			name: "completion then cancel",
			act: func(rpc *ServerRPC) {
				_ = rpc.HandleCallData(
					NewCallDataPacket(nil, false, true, nil).GetCallData(),
				)
				_ = rpc.HandleCallCancel()
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rpc := NewServerRPC(context.Background(), nil, &closeCountingPacketWriter{})
			tc.act(rpc)
			kind, err := rpc.WaitTerminal(context.Background())
			if err != nil {
				t.Fatalf("wait terminal: %v", err)
			}
			if kind != TerminalKind_TERMINAL_KIND_COMMITTED {
				t.Fatalf("terminal = %v, want committed", kind)
			}
		})
	}
}

func TestServerInvocationGenuineAbandonment(t *testing.T) {
	rpc := NewServerRPC(context.Background(), nil, &closeCountingPacketWriter{})
	ownerCtx, ownerCancel := context.WithCancel(context.Background())
	result := make(chan TerminalKind, 1)
	go func() {
		kind, err := rpc.WaitTerminal(ownerCtx)
		if !errors.Is(err, context.Canceled) {
			return
		}
		result <- kind
	}()
	ownerCancel()
	select {
	case got := <-result:
		if got != TerminalKind_TERMINAL_KIND_ABANDONED {
			t.Fatalf("terminal = %v, want %v", got, TerminalKind_TERMINAL_KIND_ABANDONED)
		}
	case <-time.After(time.Second):
		t.Fatal("wait terminal did not return on owner cancellation")
	}
}

func TestServerInvocationTerminalPrecedesOwnerCancellation(t *testing.T) {
	cases := []struct {
		name string
		act  func(*ServerRPC)
		want TerminalKind
	}{
		{
			name: "explicit complete",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallData(NewCallDataPacket(nil, false, true, nil).GetCallData()); err != nil {
					t.Fatalf("handle complete: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_COMMITTED,
		},
		{
			name: "cancel",
			act: func(rpc *ServerRPC) {
				if err := rpc.HandleCallCancel(); err != nil {
					t.Fatalf("handle cancel: %v", err)
				}
			},
			want: TerminalKind_TERMINAL_KIND_CANCELED,
		},
		{
			name: "loss",
			act: func(rpc *ServerRPC) {
				rpc.HandleStreamClose(errors.New("transport loss"))
			},
			want: TerminalKind_TERMINAL_KIND_TRANSPORT_LOST,
		},
		{
			name: "bare close",
			act: func(rpc *ServerRPC) {
				rpc.HandleStreamClose(nil)
			},
			want: TerminalKind_TERMINAL_KIND_CLOSED,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rpc := NewServerRPC(context.Background(), nil, &closeCountingPacketWriter{})
			ownerCtx, ownerCancel := context.WithCancel(context.Background())
			tc.act(rpc)
			ownerCancel()

			kind, err := rpc.WaitTerminal(ownerCtx)
			if err != nil {
				t.Fatalf("wait terminal: %v", err)
			}
			if kind != tc.want {
				t.Fatalf("terminal = %v, want %v", kind, tc.want)
			}
		})
	}
}

func TestServerInvocationAccessor(t *testing.T) {
	found := make(chan bool, 1)
	rpc := NewServerRPC(context.Background(), InvokerFunc(func(_, _ string, strm Stream) (bool, error) {
		_, ok := GetServerInvocation(strm.Context())
		found <- ok
		return true, nil
	}), &closeCountingPacketWriter{})
	if err := rpc.HandleCallStart(NewCallStartPacket("service", "method", nil, false).GetCallStart()); err != nil {
		t.Fatalf("handle start: %v", err)
	}
	select {
	case ok := <-found:
		if !ok {
			t.Fatal("server invocation missing from stream context")
		}
	case <-time.After(time.Second):
		t.Fatal("invoker did not run")
	}
}
