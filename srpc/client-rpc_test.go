package srpc

import (
	"context"
	"io"
	"testing"
)

// callbackPacketWriter exercises synchronous transport callbacks.
type callbackPacketWriter struct {
	// write delivers the outgoing packet before returning.
	write func(*Packet) error
	// close interrupts pending writes.
	close func() error
}

// WritePacket invokes the test's synchronous transport.
func (w *callbackPacketWriter) WritePacket(packet *Packet) error { return w.write(packet) }

// Close interrupts the test transport.
func (w *callbackPacketWriter) Close() error { return w.close() }

func TestClientRPCSynchronousTransport(t *testing.T) {
	// A transport may deliver its reply before the request write returns.
	rpc := NewClientRPC(t.Context(), "service", "method")
	writer := &callbackPacketWriter{
		write: func(packet *Packet) error {
			return rpc.HandleCallData(&CallData{Data: []byte("reply"), Complete: true})
		},
		close: func() error {
			rpc.HandleStreamClose(io.EOF)
			return nil
		},
	}
	if err := rpc.Start(writer, false, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rpc.Close)

	// Both startup and cleanup callbacks must run outside the state lock.
	data, err := rpc.ReadOne()
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "reply" {
		t.Fatalf("unexpected response %q", data)
	}
}

func TestClientRPCCancelBlockedStart(t *testing.T) {
	// Cancel while CallStart is blocked on a peer that never reads.
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	rpc := NewClientRPC(ctx, "service", "method")
	entered, closed := make(chan struct{}), make(chan struct{})
	writer := &callbackPacketWriter{
		write: func(*Packet) error {
			close(entered)
			<-closed
			return io.ErrClosedPipe
		},
		close: func() error {
			close(closed)
			return nil
		},
	}
	done := make(chan error, 1)
	go func() { done <- rpc.Start(writer, false, nil) }()
	<-entered
	cancel()
	if err := <-done; err != io.ErrClosedPipe {
		t.Fatalf("blocked start returned %v", err)
	}
}

var _ PacketWriter = (*callbackPacketWriter)(nil)
