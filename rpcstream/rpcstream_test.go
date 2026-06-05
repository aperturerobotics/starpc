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
	client, server := newMemoryRpcStreamPair(t)
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
	client, server := newMemoryRpcStreamPair(t)
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
	client, server := newMemoryRpcStreamPair(t)
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

func TestHandleRpcStreamReleaseWaitsForActiveInvoke(t *testing.T) {
	client, server := newMemoryRpcStreamPair(t)
	releaseCh := make(chan func(), 1)
	invoked := make(chan struct{})
	ctxCanceled := make(chan struct{})
	releaseInvoke := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- HandleRpcStream(server, func(ctx context.Context, componentID string, released func()) (srpc.Invoker, func(), error) {
			releaseCh <- released
			return srpc.InvokerFunc(func(serviceID, methodID string, strm srpc.Stream) (bool, error) {
				close(invoked)
				<-strm.Context().Done()
				close(ctxCanceled)
				<-releaseInvoke
				return true, nil
			}), nil, nil
		})
	}()

	sendRpcStreamInit(t, client, "component-a")
	requireRpcStreamAck(t, client)
	sendCallStart(t, client, "test.Service", "Do")

	var release func()
	select {
	case release = <-releaseCh:
	case <-timeAfterTestTimeout():
		t.Fatal("getter did not receive release callback")
	}
	select {
	case <-invoked:
	case <-timeAfterTestTimeout():
		t.Fatal("invoker did not start")
	}

	release()
	select {
	case <-ctxCanceled:
	case <-timeAfterTestTimeout():
		t.Fatal("release did not cancel invoke context")
	}

	select {
	case err := <-done:
		t.Fatalf("HandleRpcStream returned before invoke exited: %v", err)
	default:
	}

	close(releaseInvoke)
	requireCallData(t, client, "")
	requireHandleRpcStreamDone(t, done, nil)
}

type memoryRpcStream struct {
	ctx         context.Context
	cancel      func()
	recv        <-chan *RpcStreamPacket
	send        chan<- *RpcStreamPacket
	closeSend   sync.Once
	cancelLocal sync.Once
}

func newMemoryRpcStreamPair(t *testing.T) (*memoryRpcStream, *memoryRpcStream) {
	t.Helper()
	aCtx, aCancel := newMemoryRpcContext()
	bCtx, bCancel := newMemoryRpcContext()
	aToB := make(chan *RpcStreamPacket, 16)
	bToA := make(chan *RpcStreamPacket, 16)
	a := &memoryRpcStream{
		ctx:    aCtx,
		cancel: aCancel,
		recv:   bToA,
		send:   aToB,
	}
	b := &memoryRpcStream{
		ctx:    bCtx,
		cancel: bCancel,
		recv:   aToB,
		send:   bToA,
	}
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})
	return a, b
}

type memoryRpcContext struct {
	done chan struct{}
	once sync.Once
}

func newMemoryRpcContext() (*memoryRpcContext, func()) {
	ctx := &memoryRpcContext{
		done: make(chan struct{}),
	}
	return ctx, func() {
		ctx.once.Do(func() {
			close(ctx.done)
		})
	}
}

func (m *memoryRpcContext) Deadline() (time.Time, bool) {
	return time.Time{}, false
}

func (m *memoryRpcContext) Done() <-chan struct{} {
	return m.done
}

func (m *memoryRpcContext) Err() error {
	select {
	case <-m.done:
		return context.Canceled
	default:
		return nil
	}
}

func (m *memoryRpcContext) Value(key any) any {
	return context.Background().Value(key)
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
