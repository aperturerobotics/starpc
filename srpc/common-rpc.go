package srpc

import (
	"context"
	"io"
	"sync"

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
	// mtx guards below fields
	mtx sync.Mutex
	// bcast broadcasts when below fields change
	bcast broadcast.Broadcast
	// writer is the writer to write messages to
	writer Writer
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

// Wait waits for the RPC to finish.
func (c *commonRPC) Wait(ctx context.Context) error {
	for {
		c.mtx.Lock()
		if c.dataClosed {
			err := c.remoteErr
			c.mtx.Unlock()
			return err
		}
		waiter := c.bcast.GetWaitCh()
		c.mtx.Unlock()
		select {
		case <-ctx.Done():
			return context.Canceled
		case <-waiter:
		}
	}
}

// ReadOne reads a single message and returns.
//
// returns io.EOF if the stream ended without a packet.
func (c *commonRPC) ReadOne() ([]byte, error) {
	var msg []byte
	var err error
	var ctxDone bool
	for {
		c.mtx.Lock()
		waiter := c.bcast.GetWaitCh()
		if ctxDone && !c.dataClosed {
			// context must have been canceled locally
			c.closeLocked()
			err = context.Canceled
			c.mtx.Unlock()
			return nil, err
		}
		if len(c.dataQueue) != 0 {
			msg = c.dataQueue[0]
			c.dataQueue[0] = nil
			c.dataQueue = c.dataQueue[1:]
			c.mtx.Unlock()
			return msg, nil
		}
		if c.dataClosed || c.remoteErr != nil {
			err = c.remoteErr
			if err == nil {
				err = io.EOF
			}
			c.mtx.Unlock()
			return nil, err
		}
		c.mtx.Unlock()
		select {
		case <-c.ctx.Done():
			ctxDone = true
		case <-waiter:
		}
	}
}

// WriteCallData writes a call data packet.
func (c *commonRPC) WriteCallData(data []byte, complete bool, err error) error {
	if c.writer == nil {
		return ErrCompleted
	}
	outPkt := NewCallDataPacket(data, len(data) == 0, false, nil)
	return c.writer.WritePacket(outPkt)
}

// HandleStreamClose handles the incoming stream closing w/ optional error.
func (c *commonRPC) HandleStreamClose(closeErr error) {
	c.mtx.Lock()
	defer c.mtx.Unlock()
	if closeErr != nil && c.remoteErr == nil {
		c.remoteErr = closeErr
	}
	c.dataClosed = true
	c.ctxCancel()
	if c.writer != nil {
		_ = c.writer.Close()
	}
	c.bcast.Broadcast()
}

// HandleCallCancel handles the call cancel packet.
func (c *commonRPC) HandleCallCancel() error {
	c.mtx.Lock()
	defer c.mtx.Unlock()
	if c.remoteErr != nil {
		c.remoteErr = context.Canceled
	}
	c.dataClosed = true
	if c.writer != nil {
		_ = c.writer.Close()
	}
	c.bcast.Broadcast()
	return nil
}

// HandleCallData handles the call data packet.
func (c *commonRPC) HandleCallData(pkt *CallData) error {
	c.mtx.Lock()
	defer c.mtx.Unlock()

	if c.dataClosed {
		return ErrCompleted
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

	c.bcast.Broadcast()
	return nil
}

// WriteCancel writes a call cancel packet.
func (c *commonRPC) WriteCancel() error {
	if c.writer != nil {
		return c.writer.WritePacket(NewCallCancelPacket())
	}
	return nil
}

// closeLocked releases resources held by the RPC.
func (c *commonRPC) closeLocked() {
	c.dataClosed = true
	if c.remoteErr == nil {
		c.remoteErr = context.Canceled
	}
	if c.writer != nil {
		_ = c.writer.Close()
	}
	c.bcast.Broadcast()
	c.ctxCancel()
}
