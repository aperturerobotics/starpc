package srpc

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestAcceptMuxedListenerCancellation(t *testing.T) {
	// An idle listener must not retain a blocked Accept after cancellation.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- AcceptMuxedListener(ctx, listener, nil, nil) }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("listener cancellation returned %v", err)
	}
}
