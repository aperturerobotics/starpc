package srpc

import (
	"context"
	"io"
)

// RPCStream implements the stream interface passed to implementations.
type RPCStream struct {
	// ctx is the stream context
	ctx context.Context
	// writer is the stream writer
	writer Writer
	// dataCh is the incoming data channel.
	dataCh chan []byte
}

// NewRPCStream constructs a new Stream with a ClientRPC.
// dataCh should be closed when no more messages will arrive.
func NewRPCStream(ctx context.Context, writer Writer, dataCh chan []byte) *RPCStream {
	return &RPCStream{
		ctx:    ctx,
		writer: writer,
		dataCh: dataCh,
	}
}

// Context is canceled when the Stream is no longer valid.
func (r *RPCStream) Context() context.Context {
	return r.ctx
}

// MsgSend sends the message to the remote.
func (r *RPCStream) MsgSend(msg Message) error {
	select {
	case <-r.ctx.Done():
		return context.Canceled
	default:
	}

	msgData, err := msg.MarshalVT()
	if err != nil {
		return err
	}
	outPkt := NewCallDataPacket(msgData, false, nil)
	return r.writer.MsgSend(outPkt)
}

// MsgRecv receives an incoming message from the remote.
// Parses the message into the object at msg.
func (r *RPCStream) MsgRecv(msg Message) error {
	select {
	case <-r.Context().Done():
		return context.Canceled
	case data, ok := <-r.dataCh:
		if !ok {
			return io.EOF
		}
		return msg.UnmarshalVT(data)
	}
}

// CloseSend signals to the remote that we will no longer send any messages.
func (r *RPCStream) CloseSend() error {
	outPkt := NewCallDataPacket(nil, true, nil)
	return r.writer.MsgSend(outPkt)
}

// Close closes the stream.
func (r *RPCStream) Close() error {
	_ = r.writer.Close()
	return nil
}

// _ is a type assertion
var _ Stream = ((*RPCStream)(nil))
