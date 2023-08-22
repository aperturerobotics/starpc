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

	// lookup the caller for this component id
	ctx := stream.Context()
	componentID := initInner.Init.GetComponentId()
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
func copyRpcStreamTo(s1, s2 RpcStream, errCh chan error) {
	rerr := func() error {
		pkt := srpc.NewRawMessage(nil, true)
		for {
			err := s1.MsgRecv(pkt)
			if err != nil {
				return err
			}
			if len(pkt.GetData()) == 0 {
				continue
			}
			err = s2.MsgSend(pkt)
			pkt.Clear()
			if err != nil {
				return err
			}
		}
	}()

	s1Err := s1.Close()
	if rerr == nil && s1Err != nil {
		rerr = s1Err
	}
	if rerr != nil {
		if errCh != nil {
			errCh <- rerr
		}
		_ = s2.Close()
		return
	}

	rerr = s2.CloseSend()
	if errCh != nil {
		errCh <- rerr
	}
}
