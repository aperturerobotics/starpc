package srpc

import (
	"context"

	"github.com/pkg/errors"
)

// ClientRPC represents the client side of an on-going RPC call message stream.
type ClientRPC struct {
	commonRPC
}

// NewClientRPC constructs a new ClientRPC session and writes CallStart.
// the writer will be closed when the ClientRPC completes.
// service and method must be specified.
// must call Start after creating the RPC object.
func NewClientRPC(ctx context.Context, service, method string) *ClientRPC {
	rpc := &ClientRPC{}
	initCommonRPC(ctx, &rpc.commonRPC)
	rpc.service = service
	rpc.method = method
	return rpc
}

// Start sets the writer and writes the MsgSend message.
// must only be called once!
func (r *ClientRPC) Start(writer Writer, writeFirstMsg bool, firstMsg []byte) error {
	select {
	case <-r.ctx.Done():
		r.ctxCancel()
		return context.Canceled
	default:
	}
	r.mtx.Lock()
	defer r.mtx.Unlock()
	defer r.bcast.Broadcast()
	r.writer = writer
	var firstMsgEmpty bool
	if writeFirstMsg {
		firstMsgEmpty = len(firstMsg) == 0
	}
	pkt := NewCallStartPacket(r.service, r.method, firstMsg, firstMsgEmpty)
	if err := writer.WritePacket(pkt); err != nil {
		r.ctxCancel()
		_ = writer.Close()
		return err
	}
	return nil
}

// HandlePacketData handles an incoming unparsed message packet.
func (r *ClientRPC) HandlePacketData(data []byte) error {
	pkt := &Packet{}
	if err := pkt.UnmarshalVT(data); err != nil {
		return err
	}
	return r.HandlePacket(pkt)
}

// HandleStreamClose handles the stream closing optionally w/ an error.
func (r *ClientRPC) HandleStreamClose(closeErr error) {
	r.mtx.Lock()
	defer r.mtx.Unlock()
	defer r.bcast.Broadcast()
	if closeErr != nil && r.remoteErr == nil {
		r.remoteErr = closeErr
	}
	r.dataClosed = true
	r.ctxCancel()
}

// HandlePacket handles an incoming parsed message packet.
func (r *ClientRPC) HandlePacket(msg *Packet) error {
	if err := msg.Validate(); err != nil {
		return err
	}

	switch b := msg.GetBody().(type) {
	case *Packet_CallStart:
		return r.HandleCallStart(b.CallStart)
	case *Packet_CallData:
		return r.HandleCallData(b.CallData)
	case *Packet_CallCancel:
		if b.CallCancel {
			return r.HandleCallCancel()
		}
		return nil
	default:
		return nil
	}
}

// HandleCallStart handles the call start packet.
func (r *ClientRPC) HandleCallStart(pkt *CallStart) error {
	// server-to-client calls not supported
	return errors.Wrap(ErrUnrecognizedPacket, "call start packet unexpected")
}

// Close releases any resources held by the ClientRPC.
func (r *ClientRPC) Close() {
	if r.writer != nil {
		_ = r.WriteCancel()
	}
	r.mtx.Lock()
	r.closeLocked()
	r.bcast.Broadcast()
	r.mtx.Unlock()
}
