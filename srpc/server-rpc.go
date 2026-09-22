package srpc

import (
	"context"

	"github.com/pkg/errors"
)

// ServerRPC runs one remote method and retains its resources until the handler exits.
type ServerRPC struct {
	commonRPC

	// invoker dispatches the selected service and method.
	invoker Invoker
}

// NewServerRPC attaches the handler and transport for one incoming call.
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
	// Ignore an absent packet and reject malformed messages before dispatch.
	if msg == nil {
		return nil
	}
	if err := msg.Validate(); err != nil {
		return err
	}

	// Route each packet through the shared stream state.
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
	// Accept one start before any terminal stream transition.
	locked := r.bcast.Lock()
	if r.method != "" || r.service != "" {
		locked.Unlock()
		return errors.New("call start must be sent only once")
	}
	if r.dataClosed {
		locked.Unlock()
		return ErrCompleted
	}

	// Retain the request identity and optional first message for the handler.
	service, method := pkt.GetRpcService(), pkt.GetRpcMethod()
	r.service, r.method = service, method
	if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
		r.dataQueue = append(r.dataQueue, data)
	}

	// Wait is used as a resource lifetime barrier by rpcstream components.
	// Mark the method active before scheduling it so cancellation cannot make
	// Wait return and release a mux while invokeRPC is still running user code.
	r.localActive = true
	locked.Broadcast()
	startServerRPCInvoke(func() {
		r.invokeRPC(service, method)
	})
	locked.Unlock()

	return nil
}

// invokeRPC invokes the RPC after CallStart is received.
func (r *ServerRPC) invokeRPC(serviceID, methodID string) {
	// Run the selected handler before publishing its terminal result.
	strm := NewMsgStream(r.ctx, r, r.cancelContext)
	ok, err := r.invoker.InvokeMethod(serviceID, methodID, strm)
	if err == nil && !ok {
		err = ErrUnimplemented
	}

	// Cancellation has its own packet; a text error would lose its identity.
	outPkt := NewCallDataPacket(nil, false, true, err)
	if errors.Is(err, context.Canceled) {
		outPkt = NewCallCancelPacket()
	}
	r.beginLocalCompletion()
	if err := r.writer.WritePacket(outPkt); err != nil {
		r.HandleStreamClose(err)
	}
	r.finishLocalCompletion()
}
