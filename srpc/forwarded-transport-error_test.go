package srpc

import (
	"context"
	"testing"

	"github.com/pkg/errors"
)

// TestForwardedTransportError preserves typed transport loss across two proxy
// hops, including errors wrapped by the remote and messages matching a sentinel.
func TestForwardedTransportError(t *testing.T) {
	for _, original := range []error{
		ErrReset,
		errors.Wrap(ErrReset, "plugin transport"),
		ErrClosedBeforeCompletion,
		errors.Wrap(ErrClosedBeforeCompletion, "plugin transport"),
		errors.New(ErrReset.Error()),
	} {
		t.Run(original.Error(), func(t *testing.T) {
			// Forward a real transport failure through two server/client packet boundaries.
			remote := NewClient(func(_ context.Context, _ PacketDataHandler, closed CloseHandler) (PacketWriter, error) {
				return &callbackPacketWriter{
					write: func(*Packet) error {
						closed(original)
						return nil
					},
					close: func() error { return nil },
				}, nil
			})
			for range 2 {
				remote = NewClient(NewServerPipe(NewServer(NewClientInvoker(remote))))
			}

			// Read the forwarded outcome and compare its identity and original diagnostic.
			stream, err := remote.NewStream(t.Context(), "service", "method", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			err = stream.MsgRecv(NewRawMessage(nil, true))
			if err == nil || err.Error() != original.Error() {
				t.Fatalf("forwarded diagnostic = %v, want %v", err, original)
			}
			for _, cause := range []error{ErrReset, ErrClosedBeforeCompletion} {
				if errors.Is(err, cause) != errors.Is(original, cause) {
					t.Fatalf("forwarded error %v changed identity of %v", err, cause)
				}
			}
		})
	}
}
