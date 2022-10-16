package srpc

import (
	"context"
	"io"

	"github.com/pkg/errors"
)

// ClientRPC represents the client side of an on-going RPC call message stream.
// Not concurrency safe: use a mutex if calling concurrently.
type ClientRPC struct {
	// ctx is the context, canceled when the rpc ends.
	ctx context.Context
	// ctxCancel is called when the rpc ends.
	ctxCancel context.CancelFunc
	// writer is the writer to write messages to
	writer Writer
	// service is the rpc service
	service string
	// method is the rpc method
	method string
	// dataCh contains queued data packets.
	// closed when the client closes the channel.
	dataCh chan []byte
	// dataChClosed is a flag set after dataCh is closed.
	// controlled by HandlePacket.
	dataChClosed bool
	// serverErr is an error set by the client.
	// before dataCh is closed, managed by HandlePacket.
	// immutable after dataCh is closed.
	serverErr error
}

// NewClientRPC constructs a new ClientRPC session and writes CallStart.
// the writer will be closed when the ClientRPC completes.
// service and method must be specified.
// must call Start after creating the RPC object.
func NewClientRPC(ctx context.Context, service, method string) *ClientRPC {
	rpc := &ClientRPC{
		service: service,
		method:  method,
		dataCh:  make(chan []byte, 5),
	}
	rpc.ctx, rpc.ctxCancel = context.WithCancel(ctx)
	return rpc
}

// Start sets the writer and writes the MsgSend message.
// must only be called once!
func (r *ClientRPC) Start(writer Writer, writeFirstMsg bool, firstMsg []byte) error {
	select {
	case <-r.ctx.Done():
		r.Close()
		return context.Canceled
	default:
	}
	r.writer = writer
	var firstMsgEmpty bool
	if writeFirstMsg {
		firstMsgEmpty = len(firstMsg) == 0
	} else {
		firstMsg = nil
	}
	pkt := NewCallStartPacket(r.service, r.method, firstMsg, firstMsgEmpty)
	if err := writer.WritePacket(pkt); err != nil {
		r.Close()
		return err
	}
	return nil
}

// ReadAll reads all returned Data packets and returns any error.
// intended for use with unary rpcs.
func (r *ClientRPC) ReadAll() ([][]byte, error) {
	msgs := make([][]byte, 0, 1)
	for {
		select {
		case <-r.ctx.Done():
			return msgs, context.Canceled
		case data, ok := <-r.dataCh:
			if !ok {
				return msgs, r.serverErr
			}
			msgs = append(msgs, data)
		}
	}
}

// ReadOne reads a single message and returns.
//
// returns io.EOF if the stream ended.
func (r *ClientRPC) ReadOne() ([]byte, error) {
	select {
	case <-r.ctx.Done():
		return nil, context.Canceled
	case data, ok := <-r.dataCh:
		if !ok {
			if err := r.serverErr; err != nil {
				return nil, err
			}
			return nil, io.EOF
		}
		return data, nil
	}
}

// Context is canceled when the ClientRPC is no longer valid.
func (r *ClientRPC) Context() context.Context {
	return r.ctx
}

// HandlePacketData handles an incoming unparsed message packet.
// Not concurrency safe: use a mutex if calling concurrently.
func (r *ClientRPC) HandlePacketData(data []byte) error {
	pkt := &Packet{}
	if err := pkt.UnmarshalVT(data); err != nil {
		return err
	}
	return r.HandlePacket(pkt)
}

// HandleStreamClose handles the incoming stream closing w/ optional error.
func (r *ClientRPC) HandleStreamClose(closeErr error) {
	if closeErr != nil {
		if r.serverErr == nil {
			r.serverErr = closeErr
		}
		r.Close()
	}
}

// HandlePacket handles an incoming parsed message packet.
// Not concurrency safe: use a mutex if calling concurrently.
func (r *ClientRPC) HandlePacket(msg *Packet) error {
	if err := msg.Validate(); err != nil {
		return err
	}

	switch b := msg.GetBody().(type) {
	case *Packet_CallStart:
		return r.HandleCallStart(b.CallStart)
	case *Packet_CallData:
		return r.HandleCallData(b.CallData)
	default:
		return nil
	}
}

// HandleCallStart handles the call start packet.
func (r *ClientRPC) HandleCallStart(pkt *CallStart) error {
	// server-to-client calls not supported
	return errors.Wrap(ErrUnrecognizedPacket, "call start packet unexpected")
}

// HandleCallData handles the call data packet.
func (r *ClientRPC) HandleCallData(pkt *CallData) error {
	if r.dataChClosed {
		return ErrCompleted
	}

	if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
		select {
		case <-r.ctx.Done():
			return context.Canceled
		case r.dataCh <- data:
		}
	}

	complete := pkt.GetComplete()
	if err := pkt.GetError(); len(err) != 0 {
		complete = true
		r.serverErr = errors.New(err)
	}

	if complete {
		r.dataChClosed = true
		close(r.dataCh)
	}

	return nil
}

// Close releases any resources held by the ClientRPC.
// not concurrency safe with HandlePacket.
func (r *ClientRPC) Close() {
	r.ctxCancel()
	if r.writer != nil {
		_ = r.writer.Close()
	}
}
