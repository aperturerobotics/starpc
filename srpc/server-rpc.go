package srpc

import (
	"context"

	"github.com/pkg/errors"
)

// ServerRPC represents the server side of an on-going RPC call message stream.
type ServerRPC struct {
	commonRPC
	// invoker is the rpc call invoker
	invoker Invoker
}

// NewServerRPC constructs a new ServerRPC session.
// note: call SetWriter before handling any incoming messages.
func NewServerRPC(ctx context.Context, invoker Invoker, writer PacketWriter) *ServerRPC {
	rpc := &ServerRPC{invoker: invoker}
	initCommonRPC(ctx, &rpc.commonRPC)
	rpc.writer = writer
	return rpc
}

// HandlePacketData handles an incoming unparsed message packet.
func (r *ServerRPC) HandlePacketData(data []byte) error {
	msg := &Packet{}
	if err := msg.UnmarshalVT(data); err != nil {
		return err
	}
	return r.HandlePacket(msg)
}

// HandlePacket handles an incoming parsed message packet.
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
func (r *ServerRPC) HandleCallStart(pkt *CallStart) error {
	var err error

	r.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		// process start: method and service
		if r.method != "" || r.service != "" {
			err = errors.New("call start must be sent only once")
			return
		}
		if r.dataClosed {
			err = ErrCompleted
			return
		}

		service, method := pkt.GetRpcService(), pkt.GetRpcMethod()
		r.service, r.method = service, method

		// process first data packet, if included
		if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
			r.dataQueue = append(r.dataQueue, data)
		}

		// invoke the rpc
		broadcast()
		go r.invokeRPC(service, method)
	})

	return err
}

// invokeRPC invokes the RPC after CallStart is received.
func (r *ServerRPC) invokeRPC(serviceID, methodID string) {
	strm := NewMsgStream(r.ctx, r, r.ctxCancel)
	ok, err := r.invoker.InvokeMethod(serviceID, methodID, strm)
	if err == nil && !ok {
		err = ErrUnimplemented
	}
	outPkt := NewCallDataPacket(nil, false, true, err)
	_ = r.writer.WritePacket(outPkt)
	_ = r.writer.Close()
	r.ctxCancel()
}
