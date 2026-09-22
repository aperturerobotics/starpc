package srpc

import (
	"context"

	"github.com/pkg/errors"
)

// ClientRPC represents the client side of an on-going RPC call message stream.
type ClientRPC struct {
	commonRPC
}

// NewClientRPC constructs a call with the given service and method.
// Start attaches its transport; Close releases it.
func NewClientRPC(ctx context.Context, service, method string) *ClientRPC {
	rpc := &ClientRPC{}
	initCommonRPC(ctx, &rpc.commonRPC)
	rpc.service = service
	rpc.method = method
	return rpc
}

// Start attaches one writer and sends CallStart without holding the state lock.
func (r *ClientRPC) Start(writer PacketWriter, writeFirstMsg bool, firstMsg []byte) error {
	// Validate the call before transferring the transport to it.
	if writer == nil {
		return ErrNilWriter
	}
	if !writeFirstMsg {
		firstMsg = nil
	}
	pkt := NewCallStartPacket(r.service, r.method, firstMsg, writeFirstMsg && len(firstMsg) == 0)
	if err := pkt.Validate(); err != nil {
		return err
	}

	// Publish the writer before transport callbacks can deliver a response.
	locked := r.bcast.Lock()
	if r.writer != nil {
		locked.Unlock()
		return ErrCompleted
	}
	r.writer = writer
	locked.Broadcast()
	locked.Unlock()

	// Cancellation closes the transport even when its first write is blocked.
	stop := context.AfterFunc(r.ctx, r.Close)
	defer stop()
	if err := r.ctx.Err(); err != nil {
		r.Close()
		return err
	}
	if err := writer.WritePacket(pkt); err != nil {
		r.Close()
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
	r.commonRPC.HandleStreamClose(closeErr)
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
	return errors.Wrap(ErrUnrecognizedPacket, "call start packet unexpected")
}

// Close releases any resources held by the ClientRPC.
func (r *ClientRPC) Close() {
	// Settle the call before releasing a transport that can call back into it.
	locked := r.bcast.Lock()
	writer := r.closeLocked(&locked)
	locked.Unlock()

	// Closing the transport interrupts pending writes; sending cancellation first
	// could itself block forever behind a peer that stopped reading.
	if writer != nil {
		_ = writer.Close()
	}
}
