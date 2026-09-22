package srpc

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestServerCancellationRetainsIdentity checks cancellation across the wire,
// independently of the client's own context cancellation.
func TestServerCancellationRetainsIdentity(t *testing.T) {
	// Exercise the real packet codec and pipe with a canceled remote handler.
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	server := NewServer(InvokerFunc(func(string, string, Stream) (bool, error) {
		return true, context.Canceled
	}))
	rpc := NewClientRPC(ctx, "service", "method")
	defer rpc.Close()
	writer, err := NewServerPipe(server)(ctx, rpc.HandlePacketData, rpc.HandleStreamClose)
	if err != nil {
		t.Fatal(err)
	}
	if err := rpc.Start(writer, false, nil); err != nil {
		t.Fatal(err)
	}

	// Both receive and completion must retain the remote cancellation sentinel.
	if _, err := rpc.ReadOne(); !errors.Is(err, context.Canceled) {
		t.Fatalf("receive cancellation = %v", err)
	}
	if err := rpc.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("completion cancellation = %v", err)
	}
	if err := ctx.Err(); err != nil {
		t.Fatal("client deadline hid the remote cancellation", err)
	}
}
