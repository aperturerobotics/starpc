package srpc

import (
	"context"

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
// firstMsg can be nil, but is usually set if this is a non-streaming rpc.
// must only be called once!
func (r *ClientRPC) Start(writer Writer, firstMsg []byte) error {
	select {
	case <-r.ctx.Done():
		r.Close()
		return context.Canceled
	default:
	}
	if err := writer.MsgSend(NewCallStartPacket(r.service, r.method, firstMsg)); err != nil {
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
	case *Packet_CallStartResp:
		return r.HandleCallStartResp(b.CallStartResp)
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

	if data := pkt.GetData(); len(data) != 0 {
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

// HandleCallStartResp handles the CallStartResp packet.
func (r *ClientRPC) HandleCallStartResp(resp *CallStartResp) error {
	// client-side calls not supported
	return errors.Wrap(ErrUnrecognizedPacket, "call start resp packet unexpected")
}

// Close releases any resources held by the ClientRPC.
// not concurrency safe with HandlePacket.
func (r *ClientRPC) Close() {
	r.ctxCancel()
	_ = r.writer.Close()
}
