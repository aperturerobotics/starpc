package srpc

import (
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
			writerClosedOutsideLock = rpc.bcast.TryHoldLock(func(func(), func() <-chan struct{}) {})
		},
	}
	rpc = NewServerRPC(context.Background(), InvokerFunc(nil), writer)

	rpc.HandleStreamClose(io.EOF)

	if !writerClosedOutsideLock {
		t.Fatal("expected writer close outside broadcast lock")
	}
}
