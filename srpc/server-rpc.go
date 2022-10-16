package srpc

import (
	"context"
	"io"

	"github.com/pkg/errors"
)

// ServerRPC represents the server side of an on-going RPC call message stream.
// Not concurrency safe: use a mutex if calling concurrently.
type ServerRPC struct {
	// ctx is the context, canceled when the rpc ends.
	ctx context.Context
	// ctxCancel is called when the rpc ends.
	ctxCancel context.CancelFunc
	// writer is the writer to write messages to
	writer Writer
	// invoker is the rpc call invoker
	invoker Invoker
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
	// clientErr is an error set by the client.
	// before dataCh is closed, managed by HandlePacket.
	// immutable after dataCh is closed or ctxCancel
	clientErr error
}

// NewServerRPC constructs a new ServerRPC session.
// note: call SetWriter before handling any incoming messages.
func NewServerRPC(ctx context.Context, invoker Invoker) *ServerRPC {
	rpc := &ServerRPC{
		dataCh:  make(chan []byte, 5),
		invoker: invoker,
	}
	rpc.ctx, rpc.ctxCancel = context.WithCancel(ctx)
	return rpc
}

// SetWriter sets the writer field.
func (r *ServerRPC) SetWriter(w Writer) {
	r.writer = w
}

// Context is canceled when the ServerRPC is no longer valid.
func (r *ServerRPC) Context() context.Context {
	return r.ctx
}

// Wait waits for the RPC to finish.
func (r *ServerRPC) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return context.Canceled
	case <-r.ctx.Done():
	}
	return r.clientErr
}

// HandleStreamClose handles the incoming stream closing w/ optional error.
func (r *ServerRPC) HandleStreamClose(closeErr error) {
	if r.dataChClosed {
		return
	}
	if closeErr != nil {
		if r.clientErr == nil {
			r.clientErr = closeErr
		}
		if closeErr != io.EOF && closeErr != context.Canceled {
			r.Close()
		}
	}
	r.dataChClosed = true
	close(r.dataCh)
}

// HandlePacket handles an incoming parsed message packet.
// Not concurrency safe: use a mutex if calling concurrently.
func (r *ServerRPC) HandlePacket(msg *Packet) error {
	if msg == nil {
		return nil
	}
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
func (r *ServerRPC) HandleCallStart(pkt *CallStart) error {
	// process start: method and service
	if r.method != "" || r.service != "" {
		return errors.New("call start must be sent only once")
	}
	if r.dataChClosed {
		return ErrCompleted
	}
	r.method, r.service = pkt.GetRpcMethod(), pkt.GetRpcService()

	// process first data packet, if included
	if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
		if data == nil {
			data = []byte{}
		}
		select {
		case r.dataCh <- data:
		default:
			// the channel should be empty w/ a buffer capacity of 5 here.
			return errors.New("data channel was full, expected empty")
		}
	}

	// invoke the rpc
	go r.invokeRPC()

	return nil
}

// HandleCallData handles the call data packet.
func (r *ServerRPC) HandleCallData(pkt *CallData) error {
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
		r.clientErr = errors.New(err)
	}

	if complete {
		r.dataChClosed = true
		close(r.dataCh)
	}

	return nil
}

// invoke invokes the RPC after CallStart is received.
func (r *ServerRPC) invokeRPC() {
	// ctx := r.ctx
	serviceID, methodID := r.service, r.method
	strm := NewMsgStream(r.ctx, r.writer, r.dataCh, r.ctxCancel)
	ok, err := r.invoker.InvokeMethod(serviceID, methodID, strm)
	if err == nil && !ok {
		err = ErrUnimplemented
	}
	outPkt := NewCallDataPacket(nil, false, true, err)
	_ = r.writer.WritePacket(outPkt)
	_ = r.writer.Close()
	r.ctxCancel()
}

// Close releases any resources held by the ServerRPC.
// not concurrency safe with HandlePacket.
func (r *ServerRPC) Close() {
	if r.clientErr == nil {
		r.clientErr = context.Canceled
	}
	if r.service == "" {
		// invokeRPC has not been called, otherwise it would call Close()
		_ = r.writer.Close()
	}
	r.ctxCancel()
}
