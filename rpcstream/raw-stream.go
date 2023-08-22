package rpcstream

import (
	"context"
	"io"
)

// RpcRawGetter returns a read/write/closer to proxy data to/from.
// Returns a release function to call when done with the stream.
// The caller will call stream.Close as well as the release function (if any).
// Returns nil, nil, nil if not found.
type RpcRawGetter func(ctx context.Context, componentID string) (io.ReadWriteCloser, func(), error)

// HandleRawRpcStream handles an incoming RPC stream proxying to a ReadWriteCloser.
func HandleRawRpcStream(stream RpcStream, getter RpcRawGetter) error {
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
	remoteRwc, remoteRwcRel, err := getter(ctx, componentID)
	if err == nil && remoteRwc == nil {
		err = ErrNoServerForComponent
	}
	if remoteRwcRel != nil {
		defer remoteRwcRel()
	}
	if remoteRwc != nil {
		defer remoteRwc.Close()
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

	// proxy the stream
	// we re-use the rpcstream message framing here.
	// 1 incoming message = 1 outgoing message
	srw := NewRpcStreamReadWriter(stream)
	errCh := make(chan error, 2)
	go copyRwcTo(remoteRwc, srw, errCh)
	go copyRwcTo(srw, remoteRwc, errCh)

	// wait for both errors
	var outErr error
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil && outErr == nil && err != io.EOF {
			outErr = err
		}
	}
	return outErr
}

func copyRwcTo(s1, s2 io.ReadWriteCloser, errCh chan error) {
	buf := make([]byte, 8192)
	_, err := io.CopyBuffer(s2, s1, buf)
	_ = s1.Close()
	_ = s2.Close()
	if errCh != nil {
		errCh <- err
	}
}
