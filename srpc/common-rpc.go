package srpc

import (
	"context"
	"io"

	"github.com/aperturerobotics/util/broadcast"
	"github.com/pkg/errors"
)

// commonRPC contains common logic between server/client rpc.
type commonRPC struct {
	// ctx is the context, canceled when the rpc ends.
	ctx context.Context
	// ctxCancel is called when the rpc ends.
	ctxCancel context.CancelFunc
	// service is the rpc service
	service string
	// method is the rpc method
	method string
	// bcast guards below fields
	bcast broadcast.Broadcast
	// writer is the writer to write messages to
	writer PacketWriter
	// dataQueue contains incoming data packets.
	// note: packets may be len() == 0
	dataQueue [][]byte
	// dataClosed is a flag set after dataQueue is closed.
	// controlled by HandlePacket.
	dataClosed bool
	// remoteErr is an error set by the remote.
	remoteErr error
}

// initCommonRPC initializes the commonRPC.
func initCommonRPC(ctx context.Context, rpc *commonRPC) {
	rpc.ctx, rpc.ctxCancel = context.WithCancel(ctx)
}

// Context is canceled when the rpc has finished.
func (c *commonRPC) Context() context.Context {
	return c.ctx
}

// Wait waits for the RPC to finish (remote end closed the stream).
func (c *commonRPC) Wait(ctx context.Context) error {
	for {
		var dataClosed bool
		var err error
		var waitCh <-chan struct{}
		c.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
			dataClosed, err = c.dataClosed, c.remoteErr
			waitCh = getWaitCh()
		})

		if dataClosed {
			return err
		}

		select {
		case <-ctx.Done():
			return context.Canceled
		case <-waitCh:
		}
	}
}

// ReadOne reads a single message and returns.
//
// returns io.EOF if the stream ended without a packet.
func (c *commonRPC) ReadOne() ([]byte, error) {
	var hasMsg bool
	var msg []byte
	var err error
	var ctxDone bool
	for {
		var waitCh <-chan struct{}
		c.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
			if ctxDone && !c.dataClosed {
				// context must have been canceled locally
				c.closeLocked(broadcast)
				err = context.Canceled
				return
			}

			if len(c.dataQueue) != 0 {
				msg = c.dataQueue[0]
				hasMsg = true
				c.dataQueue[0] = nil
				c.dataQueue = c.dataQueue[1:]
			} else if c.dataClosed || c.remoteErr != nil {
				err = c.remoteErr
				if err == nil {
					err = io.EOF
				}
			}

			waitCh = getWaitCh()
		})

		if hasMsg {
			return msg, nil
		}

		if err != nil {
			return nil, err
		}

		select {
		case <-c.ctx.Done():
			ctxDone = true
		case <-waitCh:
		}
	}
}

// WriteCallData writes a call data packet.
func (c *commonRPC) WriteCallData(data []byte, complete bool, err error) error {
	outPkt := NewCallDataPacket(data, len(data) == 0, complete, err)
	return c.writer.WritePacket(outPkt)
}

// HandleStreamClose handles the incoming stream closing w/ optional error.
func (c *commonRPC) HandleStreamClose(closeErr error) {
	c.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		if closeErr != nil && c.remoteErr == nil {
			c.remoteErr = closeErr
		}
		c.dataClosed = true
		c.ctxCancel()
		_ = c.writer.Close()
		broadcast()
	})
}

// HandleCallCancel handles the call cancel packet.
func (c *commonRPC) HandleCallCancel() error {
	c.HandleStreamClose(context.Canceled)
	return nil
}

// HandleCallData handles the call data packet.
func (c *commonRPC) HandleCallData(pkt *CallData) error {
	var err error
	c.bcast.HoldLock(func(broadcast func(), getWaitCh func() <-chan struct{}) {
		if c.dataClosed {
			err = ErrCompleted
			return
		}

		if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
			c.dataQueue = append(c.dataQueue, data)
		}

		complete := pkt.GetComplete()
		if err := pkt.GetError(); len(err) != 0 {
			complete = true
			c.remoteErr = errors.New(err)
		}

		if complete {
			c.dataClosed = true
		}

		broadcast()
	})

	return err
}

// WriteCallCancel writes a call cancel packet.
func (c *commonRPC) WriteCallCancel() error {
	return c.writer.WritePacket(NewCallCancelPacket())
}

// closeLocked releases resources held by the RPC.
func (c *commonRPC) closeLocked(broadcast func()) {
	c.dataClosed = true
	if c.remoteErr == nil {
		c.remoteErr = context.Canceled
	}
	_ = c.writer.Close()
	broadcast()
	c.ctxCancel()
}
