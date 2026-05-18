package srpc

import (
	"bytes"
	"context"
	"io"
	"sync/atomic"
	"testing"
)

type closeCountingPacketWriter struct {
	closed atomic.Int32
}

type closeCallbackPacketWriter struct {
	closeFn func()
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

func TestCommonRPCHandleStreamCloseIdempotent(t *testing.T) {
	writer := &closeCountingPacketWriter{}
	rpc := NewServerRPC(context.Background(), InvokerFunc(nil), writer)

	rpc.HandleStreamClose(io.EOF)
	rpc.HandleStreamClose(context.Canceled)

	if got := writer.closed.Load(); got != 1 {
		t.Fatalf("expected writer closed once, got %d", got)
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
