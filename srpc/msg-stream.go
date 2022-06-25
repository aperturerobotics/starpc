package srpc

import (
	"context"
	"io"
)

// MsgStream implements the stream interface passed to implementations.
type MsgStream struct {
	// ctx is the stream context
	ctx context.Context
	// writer is the stream writer
	writer Writer
	// dataCh is the incoming data channel.
	dataCh chan []byte
}

// NewMsgStream constructs a new Stream with a ClientRPC.
// dataCh should be closed when no more messages will arrive.
func NewMsgStream(ctx context.Context, writer Writer, dataCh chan []byte) *MsgStream {
	return &MsgStream{
		ctx:    ctx,
		writer: writer,
		dataCh: dataCh,
	}
}

// Context is canceled when the Stream is no longer valid.
func (r *MsgStream) Context() context.Context {
	return r.ctx
}

// MsgSend sends the message to the remote.
func (r *MsgStream) MsgSend(msg Message) error {
	select {
	case <-r.ctx.Done():
		return context.Canceled
	default:
	}

	msgData, err := msg.MarshalVT()
	if err != nil {
		return err
	}
	outPkt := NewCallDataPacket(msgData, len(msgData) == 0, false, nil)
	return r.writer.WritePacket(outPkt)
}

// MsgRecv receives an incoming message from the remote.
// Parses the message into the object at msg.
func (r *MsgStream) MsgRecv(msg Message) error {
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
func (r *MsgStream) CloseSend() error {
	outPkt := NewCallDataPacket(nil, false, true, nil)
	return r.writer.WritePacket(outPkt)
}

// Close closes the stream.
func (r *MsgStream) Close() error {
	_ = r.writer.Close()
	return nil
}

// _ is a type assertion
var _ Stream = ((*MsgStream)(nil))
