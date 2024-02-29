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

// StreamRecv is a stream that can receive typed messages.
//
// T is the response type.
type StreamRecv[T any] interface {
	Stream
	Recv() (T, error)
	RecvTo(T) error
}

// StreamSend is a stream that can send typed messages.
//
// T is the outgoing type.
type StreamSend[T any] interface {
	Stream
	Send(T) error
}

// StreamSendAndClose is a stream that can send typed messages, closing after.
//
// T is the outgoing type.
type StreamSendAndClose[T any] interface {
	StreamSend[T]
	SendAndClose(T) error
}

// streamWithClose is a Stream with a wrapped Close function.
type streamWithClose struct {
	Stream
	closeFn func() error
}

// NewStreamWithClose wraps a Stream with a close function to call when Close is called.
func NewStreamWithClose(strm Stream, close func() error) Stream {
	return &streamWithClose{Stream: strm, closeFn: close}
}

// Close closes the stream for reading and writing.
func (s *streamWithClose) Close() error {
	err := s.Stream.Close()
	err2 := s.closeFn()
	if err != nil {
		return err
	}
	return err2
}

// _ is a type assertion
var _ Stream = (*streamWithClose)(nil)
