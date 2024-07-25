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
func (r *ClientRPC) Start(writer PacketWriter, writeFirstMsg bool, firstMsg []byte) error {
	if err := r.ctx.Err(); err != nil {
		r.ctxCancel()
		_ = writer.Close()
		return context.Canceled
	}

	var firstMsgEmpty bool
	var err error
	r.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		r.writer = writer

		if writeFirstMsg {
			firstMsgEmpty = len(firstMsg) == 0
		}

		pkt := NewCallStartPacket(r.service, r.method, firstMsg, firstMsgEmpty)
		err = writer.WritePacket(pkt)
		if err != nil {
			r.ctxCancel()
			_ = writer.Close()
		}

		broadcast()
	})

	return err
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
	r.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		if closeErr != nil && r.remoteErr == nil {
			r.remoteErr = closeErr
		}
		r.dataClosed = true
		r.ctxCancel()
		broadcast()
	})
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

	r.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		r.closeLocked(broadcast)
	})
}
