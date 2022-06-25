package rpcstream

import (
	"context"
	"errors"

	"github.com/aperturerobotics/starpc/srpc"
)

// RpcStream implements a RPC call stream over a RPC call. Used to implement
// sub-components which have a different set of services & calls available.
type RpcStream interface {
	srpc.Stream
	Send(*Packet) error
	Recv() (*Packet, error)
}

// RpcStreamGetter returns the Mux for the component ID from the remote.
type RpcStreamGetter func(ctx context.Context, componentID string) (srpc.Mux, error)

// RpcStreamCaller is a function which starts the RpcStream call.
type RpcStreamCaller func(ctx context.Context) (RpcStream, error)

// NewRpcStreamOpenStream constructs an OpenStream function with a RpcStream.
func NewRpcStreamOpenStream(componentID string, rpcCaller RpcStreamCaller) srpc.OpenStreamFunc {
	return func(ctx context.Context, msgHandler srpc.PacketHandler) (srpc.Writer, error) {
		// open the rpc stream
		rpcStream, err := rpcCaller(ctx)
		if err != nil {
			return nil, err
		}

		// write the component id
		err = rpcStream.Send(&Packet{
			Body: &Packet_Init{
				Init: &RpcStreamInit{
					ComponentId: componentID,
				},
			},
		})
		if err != nil {
			_ = rpcStream.Close()
			return nil, err
		}

		// initialize the rpc
		rw := NewRpcStreamReadWriter(rpcStream, msgHandler)

		// start the read pump
		go func() {
			err := rw.ReadPump()
			if err != nil {
				_ = rw.Close()
			}
		}()

		// return the writer
		return rw, nil
	}
}

// HandleRpcStream handles an incoming RPC stream (remote is the initiator).
func HandleRpcStream(stream RpcStream, getter RpcStreamGetter) error {
	// Read the "init" packet.
	initPkt, err := stream.Recv()
	if err != nil {
		return err
	}
	initInner, ok := initPkt.GetBody().(*Packet_Init)
	if !ok || initInner.Init == nil {
		return errors.New("expected init packet")
	}
	componentID := initInner.Init.GetComponentId()
	if componentID == "" {
		return errors.New("invalid init packet: empty component id")
	}

	// lookup the server for this component id
	ctx := stream.Context()
	mux, err := getter(ctx, componentID)
	if err != nil {
		return err
	}
	if mux == nil {
		return errors.New("no server for that component")
	}

	// handle the rpc
	serverRPC := srpc.NewServerRPC(ctx, mux)
	prw := NewRpcStreamReadWriter(stream, serverRPC.HandlePacket)
	serverRPC.SetWriter(prw)
	err = prw.ReadPump()
	_ = prw.Close()
	return err
}

// RpcStreamReadWriter reads and writes packets from a RpcStream.
type RpcStreamReadWriter struct {
	// stream is the RpcStream
	stream RpcStream
	// cb is the callback
	cb srpc.PacketHandler
}

// NewRpcStreamReadWriter constructs a new read/writer.
func NewRpcStreamReadWriter(stream RpcStream, cb srpc.PacketHandler) *RpcStreamReadWriter {
	return &RpcStreamReadWriter{stream: stream, cb: cb}
}

// WritePacket writes a packet to the writer.
func (r *RpcStreamReadWriter) WritePacket(p *srpc.Packet) error {
	data, err := p.MarshalVT()
	if err != nil {
		return err
	}
	return r.stream.Send(&Packet{
		Body: &Packet_Data{
			Data: data,
		},
	})
}

// ReadPump executes the read pump in a goroutine.
func (r *RpcStreamReadWriter) ReadPump() error {
	for {
		rpcStreamPkt, err := r.stream.Recv()
		if err != nil {
			return err
		}
		dataPkt, ok := rpcStreamPkt.GetBody().(*Packet_Data)
		if !ok {
			return errors.New("expected data packet")
		}
		pkt := &srpc.Packet{}
		if err := pkt.UnmarshalVT(dataPkt.Data); err != nil {
			return err
		}
		if err := r.cb(pkt); err != nil {
			return err
		}
	}
}

// Close closes the packet rw.
func (r *RpcStreamReadWriter) Close() error {
	return r.stream.Close()
}

// _ is a type assertion
var _ srpc.Writer = (*RpcStreamReadWriter)(nil)
