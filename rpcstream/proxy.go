package rpcstream

import (
	"context"
	"io"

	"github.com/aperturerobotics/starpc/srpc"
)

// RpcProxyGetter returns a remote rpcstream call to proxy to.
// Returns the component ID to pass to the caller.
//
// Returns a release function to call when done with the stream.
// The caller will cancel the context and close the rpc when done.
// Returns nil, "", nil, nil if not found.
type RpcProxyGetter[T RpcStream] func(ctx context.Context, componentID string) (
	caller RpcStreamCaller[T],
	callerComponentID string,
	rel func(),
	err error,
)

// HandleProxyRpcStream handles an incoming RPC stream proxying to a ReadWriteCloser.
func HandleProxyRpcStream[T RpcStream](stream RpcStream, getter RpcProxyGetter[T]) error {
	// Read the "init" packet.
	initPkt, err := stream.Recv()
	if err != nil {
		return err
	}
	initInner, ok := initPkt.GetBody().(*RpcStreamPacket_Init)
	if !ok || initInner.Init == nil {
		return ErrUnexpectedPacket
	}
	componentID := initInner.Init.GetComponentId()
	if componentID == "" {
		return ErrEmptyComponentID
	}

	// lookup the caller for this component id
	ctx := stream.Context()
	remoteCaller, remoteComponentID, remoteCallerRel, err := getter(ctx, componentID)
	if remoteCallerRel != nil {
		defer remoteCallerRel()
	} else if err == nil {
		err = ErrNoServerForComponent
	}

	// call the remote caller
	var remoteStrm RpcStream
	if err == nil {
		remoteStrm, err = remoteCaller(ctx)
		if remoteStrm != nil {
			defer remoteStrm.Close()
		} else if err == nil {
			err = ErrNoServerForComponent
		}
	}

	// send the init message
	if err == nil {
		err = remoteStrm.Send(&RpcStreamPacket{
			Body: &RpcStreamPacket_Init{
				Init: &RpcStreamInit{
					ComponentId: remoteComponentID,
				},
			},
		})
	}

	// send ack, but only if we have an error
	// otherwise: we will proxy the ack from the remote stream.
	if err != nil {
		errStr := err.Error()
		_ = stream.Send(&RpcStreamPacket{
			Body: &RpcStreamPacket_Ack{
				Ack: &RpcAck{Error: errStr},
			},
		})
		return err
	}

	errCh := make(chan error, 2)
	go copyRpcStreamTo(remoteStrm, stream, errCh)
	go copyRpcStreamTo(stream, remoteStrm, errCh)

	// wait for both errors
	var outErr error
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil && outErr == nil && err != io.EOF {
			outErr = err
		}
	}
	return outErr
}

// copies s1 to s2
func copyRpcStreamTo(s1, s2 RpcStream, errCh chan error) (rerr error) {
	defer func() {
		s1Err := s1.Close()
		if rerr == nil && s1Err != nil {
			rerr = s1Err
		}

		s2Err := s2.CloseSend()
		if rerr == nil && s2Err != nil {
			rerr = s2Err
		}

		if errCh != nil {
			errCh <- rerr
		}
	}()
	pkt := srpc.NewRawMessage(nil, true)
	for {
		rerr = s1.MsgRecv(pkt)
		if rerr != nil {
			return
		}
		if len(pkt.GetData()) == 0 {
			continue
		}
		rerr = s2.MsgSend(pkt)
		pkt.Clear()
		if rerr != nil {
			return
		}
	}
}
