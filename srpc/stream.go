package srpc

import (
	"context"
)

// Stream is a handle to an on-going bi-directional or one-directional stream RPC handle.
type Stream interface {
	// Context is canceled when the Stream is no longer valid.
	Context() context.Context

	// MsgSend sends the message to the remote.
	MsgSend(msg Message) error

	// MsgRecv receives an incoming message from the remote.
	// Parses the message into the object at msg.
	MsgRecv(msg Message) error

	// CloseSend signals to the remote that we will no longer send any messages.
	CloseSend() error

	// Close closes the stream for reading and writing.
	Close() error
}
