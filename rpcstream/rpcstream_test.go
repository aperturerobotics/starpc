package rpcstream

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperturerobotics/starpc/srpc"
)

func TestHandleRpcStreamReturnsNilAfterInnerSuccess(t *testing.T) {
	client, server := newMemoryRpcStreamPair()
	done := make(chan error, 1)
	go func() {
		done <- HandleRpcStream(server, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			if componentID != "component-a" {
				t.Errorf("unexpected component id: %s", componentID)
			}
			return srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
				if serviceID != "test.Service" {
					t.Errorf("unexpected service id: %s", serviceID)
				}
				if methodID != "Do" {
					t.Errorf("unexpected method id: %s", methodID)
				}
				return true, nil
			}), nil, nil
		})
	}()

	sendRpcStreamInit(t, client, "component-a")
	requireRpcStreamAck(t, client)
	sendCallStart(t, client, "test.Service", "Do")
	requireCallData(t, client, "")
	requireHandleRpcStreamDone(t, done, nil)
}

func TestHandleRpcStreamReturnsNilAfterInnerMethodError(t *testing.T) {
	methodErr := errors.New("method failed")
	client, server := newMemoryRpcStreamPair()
	done := make(chan error, 1)
	go func() {
		done <- HandleRpcStream(server, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			return srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
				return true, methodErr
			}), nil, nil
		})
	}()

	sendRpcStreamInit(t, client, "component-a")
	requireRpcStreamAck(t, client)
	sendCallStart(t, client, "test.Service", "Do")
	requireCallData(t, client, methodErr.Error())
	requireHandleRpcStreamDone(t, done, nil)
}

func TestHandleRpcStreamReturnsGetterError(t *testing.T) {
	getterErr := errors.New("lookup failed")
	client, server := newMemoryRpcStreamPair()
	done := make(chan error, 1)
	go func() {
		done <- HandleRpcStream(server, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			return nil, nil, getterErr
		})
	}()

	sendRpcStreamInit(t, client, "component-a")
	ack := requireRpcStreamAck(t, client)
	if got := ack.GetAck().GetError(); !strings.Contains(got, getterErr.Error()) {
		t.Fatalf("expected getter error in ack, got %q", got)
	}
	requireHandleRpcStreamDone(t, done, getterErr)
}

type memoryRpcStream struct {
	ctx         context.Context
	cancel      context.CancelFunc
	recv        <-chan *RpcStreamPacket
	send        chan<- *RpcStreamPacket
	closeSend   sync.Once
	cancelLocal sync.Once
}

func newMemoryRpcStreamPair() (*memoryRpcStream, *memoryRpcStream) {
	aCtx, aCancel := context.WithCancel(context.Background())
	bCtx, bCancel := context.WithCancel(context.Background())
	aToB := make(chan *RpcStreamPacket, 16)
	bToA := make(chan *RpcStreamPacket, 16)
	return &memoryRpcStream{
			ctx:    aCtx,
			cancel: aCancel,
			recv:   bToA,
			send:   aToB,
		}, &memoryRpcStream{
			ctx:    bCtx,
			cancel: bCancel,
			recv:   aToB,
			send:   bToA,
		}
}

func (m *memoryRpcStream) Context() context.Context {
	return m.ctx
}

func (m *memoryRpcStream) Send(pkt *RpcStreamPacket) error {
	select {
	case <-m.ctx.Done():
		return context.Canceled
	case m.send <- pkt.CloneVT():
		return nil
	}
}

func (m *memoryRpcStream) Recv() (*RpcStreamPacket, error) {
	select {
	case <-m.ctx.Done():
		return nil, context.Canceled
	case pkt, ok := <-m.recv:
		if !ok {
			return nil, io.EOF
		}
		return pkt, nil
	}
}

func (m *memoryRpcStream) MsgSend(msg srpc.Message) error {
	data, err := msg.MarshalVT()
	if err != nil {
		return err
	}
	return m.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Data{
			Data: data,
		},
	})
}

func (m *memoryRpcStream) MsgRecv(msg srpc.Message) error {
	for {
		pkt, err := m.Recv()
		if err != nil {
			return err
		}
		data := pkt.GetData()
		if len(data) == 0 {
			continue
		}
		return msg.UnmarshalVT(data)
	}
}

func (m *memoryRpcStream) CloseSend() error {
	m.closeSend.Do(func() {
		close(m.send)
	})
	return nil
}

func (m *memoryRpcStream) Close() error {
	_ = m.CloseSend()
	m.cancelLocal.Do(m.cancel)
	return nil
}

func sendRpcStreamInit(t *testing.T, stream RpcStream, componentID string) {
	t.Helper()
	if err := stream.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Init{
			Init: &RpcStreamInit{
				ComponentId: componentID,
			},
		},
	}); err != nil {
		t.Fatalf("send init: %v", err)
	}
}

func requireRpcStreamAck(t *testing.T, stream RpcStream) *RpcStreamPacket {
	t.Helper()
	pkt, err := stream.Recv()
	if err != nil {
		t.Fatalf("receive ack: %v", err)
	}
	if pkt.GetAck() == nil {
		t.Fatalf("expected ack packet, got %T", pkt.GetBody())
	}
	return pkt
}

func sendCallStart(t *testing.T, stream RpcStream, serviceID, methodID string) {
	t.Helper()
	pkt := srpc.NewCallStartPacket(serviceID, methodID, nil, false)
	data, err := pkt.MarshalVT()
	if err != nil {
		t.Fatalf("marshal call start: %v", err)
	}
	if err := stream.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Data{
			Data: data,
		},
	}); err != nil {
		t.Fatalf("send call start: %v", err)
	}
}

func requireCallData(t *testing.T, stream RpcStream, wantErr string) {
	t.Helper()
	pkt, err := stream.Recv()
	if err != nil {
		t.Fatalf("receive call data: %v", err)
	}
	var rpcPkt srpc.Packet
	if err := rpcPkt.UnmarshalVT(pkt.GetData()); err != nil {
		t.Fatalf("unmarshal call data: %v", err)
	}
	callData := rpcPkt.GetCallData()
	if callData == nil {
		t.Fatalf("expected call data, got %T", rpcPkt.GetBody())
	}
	if gotErr := callData.GetError(); gotErr != wantErr {
		t.Fatalf("expected call data error %q, got %q", wantErr, gotErr)
	}
	if !callData.GetComplete() {
		t.Fatal("expected completed call data")
	}
}

func requireHandleRpcStreamDone(t *testing.T, done <-chan error, want error) {
	t.Helper()
	select {
	case err := <-done:
		if !errors.Is(err, want) {
			t.Fatalf("expected HandleRpcStream error %v, got %v", want, err)
		}
	case <-timeAfterTestTimeout():
		t.Fatal("timed out waiting for HandleRpcStream")
	}
}

func timeAfterTestTimeout() <-chan time.Time {
	return time.After(time.Second)
}

// _ is a type assertion.
var _ RpcStream = ((*memoryRpcStream)(nil))
