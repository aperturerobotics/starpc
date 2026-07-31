package srpc

import (
	"context"
	"errors"
)

var (
	// ErrReset is returned when a stream is reset.
	ErrReset = errors.New("stream reset")
	// ErrUnimplemented is returned if the RPC method was not implemented.
	ErrUnimplemented = errors.New("unimplemented")
	// ErrCompleted is returned if a message is received after the rpc was completed.
	ErrCompleted = errors.New("unexpected packet after rpc was completed")
	// ErrUnrecognizedPacket is returned if the packet type was not recognized.
	ErrUnrecognizedPacket = errors.New("unrecognized packet type")
	// ErrEmptyPacket is returned if nothing is specified in a packet.
	ErrEmptyPacket = errors.New("invalid empty packet")
	// ErrInvalidMessage indicates the message failed to parse.
	ErrInvalidMessage = errors.New("invalid message")
	// ErrEmptyMethodID is returned if the method id was empty.
	ErrEmptyMethodID = errors.New("method id empty")
	// ErrEmptyServiceID is returned if the service id was empty.
	ErrEmptyServiceID = errors.New("service id empty")
	// ErrNoAvailableClients is returned if no clients were available.
	ErrNoAvailableClients = errors.New("no available rpc clients")
	// ErrNilWriter is returned if the rpc writer is nil.
	ErrNilWriter = errors.New("writer cannot be nil")
)

// ErrClosedBeforeCompletion is the error a call reports when its stream closed
// without the remote sending a completion or an error. The call has no verdict:
// the handler may have finished with its answer lost in the transport, or it may
// never have run. Anything read from the call after that point fails with this.
//
// It unwraps to context.Canceled, which is what this case reported before the
// distinction existed, so a caller that tests for cancellation keeps working.
var ErrClosedBeforeCompletion error = closedBeforeCompletion{}

// closedBeforeCompletion carries ErrClosedBeforeCompletion.
type closedBeforeCompletion struct{}

// Error returns the error message.
func (closedBeforeCompletion) Error() string {
	return "stream closed before the remote reported completion"
}

// Unwrap returns the cancellation this case reported historically.
func (closedBeforeCompletion) Unwrap() error {
	return context.Canceled
}
