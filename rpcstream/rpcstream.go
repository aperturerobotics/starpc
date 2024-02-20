package rpcstream

import (
	"context"

	"github.com/aperturerobotics/starpc/srpc"
	"github.com/pkg/errors"
)

// RpcStream implements a RPC call stream over a RPC call. Used to implement
// sub-components which have a different set of services & calls available.
type RpcStream interface {
	srpc.Stream
	Send(*RpcStreamPacket) error
	Recv() (*RpcStreamPacket, error)
}

// RpcStreamGetter returns the Mux for the component ID from the remote.
// Returns a release function to call when done with the Mux.
// Returns nil, nil, nil if not found.
type RpcStreamGetter func(ctx context.Context, componentID string) (srpc.Invoker, func(), error)

// RpcStreamCaller is a function which starts the RpcStream call.
type RpcStreamCaller[T RpcStream] func(ctx context.Context) (T, error)

// OpenRpcStream opens a RPC stream with a remote.
//
// if waitAck is set, waits for acknowledgment from the remote before returning.
func OpenRpcStream[T RpcStream](ctx context.Context, rpcCaller RpcStreamCaller[T], componentID string, waitAck bool) (RpcStream, error) {
	// open the rpc stream
	rpcStream, err := rpcCaller(ctx)
	if err != nil {
		return nil, err
	}

	// write the component id
	err = rpcStream.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Init{
			Init: &RpcStreamInit{
				ComponentId: componentID,
			},
		},
	})
	if err != nil {
		_ = rpcStream.Close()
		return nil, err
	}

	// wait for ack
	if waitAck {
		pkt, err := rpcStream.Recv()
		if err == nil {
			switch b := pkt.GetBody().(type) {
			case *RpcStreamPacket_Ack:
				if errStr := b.Ack.GetError(); errStr != "" {
					err = errors.Errorf("remote: %s", errStr)
				}
			default:
				err = errors.New("expected ack packet")
			}
		}
		if err != nil {
			_ = rpcStream.Close()
			return nil, err
		}
	}

	return rpcStream, nil
}

// NewRpcStreamOpenStream constructs an OpenStream function with a RpcStream.
//
// if waitAck is set, OpenStream waits for acknowledgment from the remote.
func NewRpcStreamOpenStream[T RpcStream](rpcCaller RpcStreamCaller[T], componentID string, waitAck bool) srpc.OpenStreamFunc {
	return func(ctx context.Context, msgHandler srpc.PacketDataHandler, closeHandler srpc.CloseHandler) (srpc.PacketWriter, error) {
		// open the stream
		rw, err := OpenRpcStream(ctx, rpcCaller, componentID, waitAck)
		if err != nil {
			return nil, err
		}

		// start the read pump
		go ReadPump(rw, msgHandler, closeHandler)
		// return the writer
		return NewRpcStreamWriter(rw), nil
	}
}

// NewRpcStreamClient constructs a Client which opens streams with a RpcStream.
//
// if waitAck is set, OpenStream waits for acknowledgment from the remote.
func NewRpcStreamClient[T RpcStream](rpcCaller RpcStreamCaller[T], componentID string, waitAck bool) srpc.Client {
	openStream := NewRpcStreamOpenStream(rpcCaller, componentID, waitAck)
	return srpc.NewClient(openStream)
}

// HandleRpcStream handles an incoming RPC stream (remote is the initiator).
func HandleRpcStream(stream RpcStream, getter RpcStreamGetter) error {
	// Read the "init" packet.
	initPkt, err := stream.Recv()
	if err != nil {
		return err
	}
	initInner, ok := initPkt.GetBody().(*RpcStreamPacket_Init)
	if !ok || initInner.Init == nil {
		return ErrUnexpectedPacket
	}

	// lookup the server for this component id
	ctx := stream.Context()
	componentID := initInner.Init.GetComponentId()
	mux, muxRel, err := getter(ctx, componentID)
	if err == nil && mux == nil {
		err = ErrNoServerForComponent
	}
	if mux != nil && muxRel != nil {
		defer muxRel()
	}

	// send ack
	var errStr string
	if err != nil {
		errStr = err.Error()
	}
	sendErr := stream.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Ack{
			Ack: &RpcAck{Error: errStr},
		},
	})
	if err != nil {
		return err
	}
	if sendErr != nil {
		return sendErr
	}

	// handle the rpc
	serverRPC := srpc.NewServerRPC(ctx, mux, NewRpcStreamWriter(stream))
	go ReadPump(stream, serverRPC.HandlePacketData, serverRPC.HandleStreamClose)
	return serverRPC.Wait(ctx)
}
