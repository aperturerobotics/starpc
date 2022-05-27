package srpc

import (
	"context"
	"io"
	"sync"
)

// pipeStream implements an in-memory stream.
// intended for testing
type pipeStream struct {
	ctx       context.Context
	ctxCancel context.CancelFunc
	// other is the other end of the stream.
	other *pipeStream
	// closeOnce ensures we close only once.
	closeOnce sync.Once
	// dataCh is the data channel
	dataCh chan []byte
}

// NewPipeStream constructs a new in-memory stream.
func NewPipeStream(ctx context.Context) (Stream, Stream) {
	s1 := &pipeStream{dataCh: make(chan []byte, 5)}
	s1.ctx, s1.ctxCancel = context.WithCancel(ctx)
	s2 := &pipeStream{other: s1, dataCh: make(chan []byte, 5)}
	s2.ctx, s2.ctxCancel = context.WithCancel(ctx)
	s1.other = s2
	return s1, s2
}

// Context is canceled when the Stream is no longer valid.
func (p *pipeStream) Context() context.Context {
	return p.ctx
}

// MsgSend sends the message to the remote.
func (p *pipeStream) MsgSend(msg Message) error {
	data, err := msg.MarshalVT()
	if err != nil {
		return err
	}
	select {
	case <-p.ctx.Done():
		return context.Canceled
	case p.other.dataCh <- data:
		return nil
	}
}

// MsgRecv receives an incoming message from the remote.
// Parses the message into the object at msg.
func (p *pipeStream) MsgRecv(msg Message) error {
	select {
	case <-p.ctx.Done():
		return context.Canceled
	case data, ok := <-p.dataCh:
		if !ok {
			return io.EOF
		}
		return msg.UnmarshalVT(data)
	}
}

// CloseSend signals to the remote that we will no longer send any messages.
func (p *pipeStream) CloseSend() error {
	p.closeRemote()
	return nil
}

// Close closes the stream.
func (p *pipeStream) Close() error {
	p.ctxCancel()
	p.closeRemote()
	return nil
}

// closeRemote closes the remote data channel.
func (p *pipeStream) closeRemote() {
	p.closeOnce.Do(func() {
		close(p.other.dataCh)
	})
}

// _ is a type assertion
var _ Stream = ((*pipeStream)(nil))
