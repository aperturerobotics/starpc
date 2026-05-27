package srpc

import (
	"bytes"
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type closeCountingPacketWriter struct {
	closed atomic.Int32
}

type closeCallbackPacketWriter struct {
	closeFn func()
}

type packetRecordingWriter struct {
	packets chan *Packet
	closed  chan struct{}
	once    sync.Once
}

func (w *closeCountingPacketWriter) WritePacket(*Packet) error {
	return nil
}

func (w *closeCountingPacketWriter) Close() error {
	w.closed.Add(1)
	return nil
}

func (w *closeCallbackPacketWriter) WritePacket(*Packet) error {
	return nil
}

func (w *closeCallbackPacketWriter) Close() error {
	if w.closeFn != nil {
		w.closeFn()
	}
	return nil
}

func newPacketRecordingWriter() *packetRecordingWriter {
	return &packetRecordingWriter{
		packets: make(chan *Packet, 1),
		closed:  make(chan struct{}),
	}
}

func (w *packetRecordingWriter) WritePacket(pkt *Packet) error {
	w.packets <- pkt
	return nil
}

func (w *packetRecordingWriter) Close() error {
	w.once.Do(func() {
		close(w.closed)
	})
	return nil
}

func TestCommonRPCHandleStreamCloseIdempotent(t *testing.T) {
	writer := &closeCountingPacketWriter{}
	rpc := NewServerRPC(context.Background(), InvokerFunc(nil), writer)

	rpc.HandleStreamClose(io.EOF)
	rpc.HandleStreamClose(context.Canceled)

	if got := writer.closed.Load(); got != 1 {
		t.Fatalf("expected writer closed once, got %d", got)
	}
}

func TestCommonRPCCancelContextIdempotent(t *testing.T) {
	var calls atomic.Int32
	rpc := &commonRPC{
		ctx: context.Background(),
		ctxCancel: func() {
			calls.Add(1)
		},
	}

	rpc.cancelContext()
	rpc.cancelContext()

	if got := calls.Load(); got != 1 {
		t.Fatalf("expected context cancel once, got %d", got)
	}
}

func TestCommonRPCHandleStreamCloseClosesWriterOutsideBroadcastLock(t *testing.T) {
	var rpc *ServerRPC
	writerClosedOutsideLock := false
	writer := &closeCallbackPacketWriter{
		closeFn: func() {
			locked, ok := rpc.bcast.TryLock()
			if ok {
				locked.Unlock()
			}
			writerClosedOutsideLock = ok
		},
	}
	rpc = NewServerRPC(context.Background(), InvokerFunc(nil), writer)

	rpc.HandleStreamClose(io.EOF)

	if !writerClosedOutsideLock {
		t.Fatal("expected writer close outside broadcast lock")
	}
}

func TestServerRPCWaitReturnsAfterLocalInvokeCompletion(t *testing.T) {
	writer := newPacketRecordingWriter()
	streamCtxCh := make(chan context.Context, 1)
	invokeErrCh := make(chan string, 1)
	rpc := NewServerRPC(context.Background(), InvokerFunc(func(serviceID, methodID string, strm Stream) (bool, error) {
		if serviceID != "service" || methodID != "method" {
			invokeErrCh <- serviceID + "/" + methodID
		}
		streamCtxCh <- strm.Context()
		return true, nil
	}), writer)

	if err := rpc.HandleCallStart(NewCallStartPacket("service", "method", nil, false).GetCallStart()); err != nil {
		t.Fatalf("handle call start: %v", err)
	}

	waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Second)
	defer waitCancel()
	if err := rpc.Wait(waitCtx); err != nil {
		t.Fatalf("wait: %v", err)
	}

	select {
	case got := <-invokeErrCh:
		t.Fatalf("unexpected invoke target: %s", got)
	default:
	}

	var streamCtx context.Context
	select {
	case streamCtx = <-streamCtxCh:
	case <-time.After(time.Second):
		t.Fatal("invoker did not receive stream context")
	}
	if err := streamCtx.Err(); err != nil {
		t.Fatalf("normal invoke completion canceled stream context: %v", err)
	}

	select {
	case pkt := <-writer.packets:
		callData := pkt.GetCallData()
		if callData == nil || !callData.GetComplete() || callData.GetError() != "" {
			t.Fatalf("expected successful completion packet, got %#v", pkt.GetBody())
		}
	default:
		t.Fatal("expected completion packet")
	}

	select {
	case <-writer.closed:
	default:
		t.Fatal("expected writer closed")
	}
}

func TestClientRPCCloseAfterRemoteCompleteClosesWriter(t *testing.T) {
	writer := &closeCountingPacketWriter{}
	rpc := NewClientRPC(context.Background(), "service", "method")
	if err := rpc.Start(writer, false, nil); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := rpc.HandleCallData(NewCallDataPacket([]byte("ok"), false, true, nil).GetCallData()); err != nil {
		t.Fatalf("handle call data: %v", err)
	}

	rpc.Close()

	if got := writer.closed.Load(); got != 1 {
		t.Fatalf("expected writer closed once, got %d", got)
	}
}

func TestClientRPCCloseClosesWriterOutsideBroadcastLock(t *testing.T) {
	var rpc *ClientRPC
	writerClosedOutsideLock := false
	writer := &closeCallbackPacketWriter{
		closeFn: func() {
			ok := rpc.bcast.TryHoldLock(func(func(), func() <-chan struct{}) {})
			writerClosedOutsideLock = ok
		},
	}
	rpc = NewClientRPC(context.Background(), "service", "method")
	if err := rpc.Start(writer, false, nil); err != nil {
		t.Fatalf("start: %v", err)
	}

	rpc.Close()

	if !writerClosedOutsideLock {
		t.Fatal("expected writer close outside broadcast lock")
	}
}

func TestCommonRPCReadOneQueuedDoesNotAllocate(t *testing.T) {
	msg := []byte("message")
	queue := make([][]byte, 1)
	rpc := NewServerRPC(context.Background(), InvokerFunc(nil), &closeCountingPacketWriter{})

	allocs := testing.AllocsPerRun(1000, func() {
		queue[0] = msg
		rpc.dataQueue = queue

		got, err := rpc.ReadOne()
		if err != nil {
			t.Fatalf("read one: %v", err)
		}
		if !bytes.Equal(got, msg) {
			t.Fatalf("expected %q, got %q", msg, got)
		}
	})

	if allocs != 0 {
		t.Fatalf("expected queued ReadOne to avoid allocations, got %f", allocs)
	}
}
