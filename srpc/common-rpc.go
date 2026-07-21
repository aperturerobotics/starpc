package srpc

import (
	"context"
	"io"
	"sync/atomic"

	"github.com/aperturerobotics/starpc/internal/contextutil"
	"github.com/aperturerobotics/util/broadcast"
	"github.com/pkg/errors"
)

// commonRPC contains common logic between server/client rpc.
type commonRPC struct {
	// ctx is the RPC context, canceled when the RPC is canceled.
	ctx context.Context
	// ctxCancel cancels ctx.
	ctxCancel context.CancelFunc
	// ctxCanceled tracks whether ctxCancel has already been called.
	ctxCanceled atomic.Bool
	// service is the rpc service
	service string
	// method is the rpc method
	method string
	// localCompleted tracks if we have sent a completion or cancel locally.
	// note: not guarded by bcast
	localCompleted atomic.Bool
	// bcast guards below fields
	bcast broadcast.Broadcast
	// writer is the writer to write messages to
	writer PacketWriter
	// writerClosed is set after writer has been closed locally.
	writerClosed bool
	// localCompleting is set while the local handler is publishing its terminal
	// packet and closing the writer.
	localCompleting bool
	// localActive is set while the local handler goroutine may still be inside
	// user code. Resource owners use Wait as a lifetime barrier, so cancellation
	// must not make Wait return while a handler can still touch mux-owned state.
	localActive bool
	// localDone is set after the local handler has completed normally.
	localDone bool
	// dataQueue contains incoming data packets.
	// note: packets may be len() == 0
	dataQueue [][]byte
	// dataClosed is a flag set after dataQueue is closed.
	// controlled by HandlePacket.
	dataClosed bool
	// remoteErr is an error set by the remote.
	remoteErr error
	// remoteCanceled distinguishes a received CallCancel from transport loss.
	remoteCanceled bool
	// remoteCompleted is set only by an explicit remote CallData completion.
	remoteCompleted bool
	// remoteTerminal is the first valid remote terminal.
	remoteTerminal TerminalKind
	// remoteTerminalSet records whether remoteTerminal is valid.
	remoteTerminalSet bool
}

// initCommonRPC initializes the commonRPC.
func initCommonRPC(ctx context.Context, rpc *commonRPC) {
	rpc.ctx, rpc.ctxCancel = contextutil.WithCancel(ctx)
}

func (c *commonRPC) cancelContext() {
	if c.ctxCanceled.Swap(true) {
		return
	}
	c.ctxCancel()
}

// Context is canceled when the rpc has finished.
func (c *commonRPC) Context() context.Context {
	return c.ctx
}

// Wait waits for the RPC to finish (remote end closed the stream).
func (c *commonRPC) Wait(ctx context.Context) error {
	for {
		var err error
		var waitCh <-chan struct{}
		var rpcCanceled bool
		var localDone bool
		locked := c.bcast.Lock()
		err = c.remoteErr
		rpcCanceled = c.ctx.Err() != nil
		// A canceled stream tells the handler to stop, but it is not proof that
		// the handler has returned. Keep waiting while localActive is true so a
		// caller that releases resources after Wait cannot race in-flight user
		// code still running on the canceled Stream context.
		if c.localActive {
			waitCh = locked.WaitCh()
			locked.Unlock()

			select {
			case <-ctx.Done():
				return context.Canceled
			case <-waitCh:
				continue
			}
		}
		localDone = c.localDone
		if err == nil && !rpcCanceled && !localDone {
			waitCh = locked.WaitCh()
		}
		locked.Unlock()

		if err != nil {
			return err
		}
		if localDone {
			return nil
		}
		if rpcCanceled {
			return context.Canceled
		}

		select {
		case <-ctx.Done():
			return context.Canceled
		case <-waitCh:
		}
	}
}

// WaitTerminal waits for and classifies the remote terminal of a held unary
// invocation.
func (c *commonRPC) WaitTerminal(ownerCtx context.Context) (TerminalKind, error) {
	var ownerDone bool
	for {
		locked := c.bcast.Lock()
		if c.remoteTerminalSet {
			terminal := c.remoteTerminal
			locked.Unlock()
			return terminal, nil
		}
		if ownerDone {
			err := ownerCtx.Err()
			locked.Unlock()
			return TerminalAbandoned, err
		}
		waitCh := locked.WaitCh()
		locked.Unlock()

		select {
		case <-ownerCtx.Done():
			ownerDone = true
		case <-waitCh:
		}
	}
}

// receiptTerminalKind returns the first valid remote terminal.
func (c *commonRPC) receiptTerminalKind() (TerminalKind, bool) {
	locked := c.bcast.Lock()
	terminal, ok := c.remoteTerminal, c.remoteTerminalSet
	locked.Unlock()
	return terminal, ok
}

// ReadOne reads a single message and returns.
//
// returns io.EOF if the stream ended without a packet.
func (c *commonRPC) ReadOne() ([]byte, error) {
	var ctxDone bool
	for {
		var waitCh <-chan struct{}
		locked := c.bcast.Lock()
		if ctxDone && !c.dataClosed {
			// context must have been canceled locally
			writer := c.closeLocked(&locked)
			locked.Unlock()
			if writer != nil {
				_ = writer.Close()
			}
			return nil, context.Canceled
		}

		if len(c.dataQueue) != 0 {
			msg := c.dataQueue[0]
			c.dataQueue[0] = nil
			c.dataQueue = c.dataQueue[1:]
			locked.Unlock()
			return msg, nil
		}

		if c.dataClosed || c.remoteErr != nil {
			err := c.remoteErr
			if err == nil {
				err = io.EOF
			}
			locked.Unlock()
			return nil, err
		}

		waitCh = locked.WaitCh()
		locked.Unlock()

		select {
		case <-c.ctx.Done():
			ctxDone = true
		case <-waitCh:
		}
	}
}

// WriteCallData writes a call data packet.
func (c *commonRPC) WriteCallData(data []byte, dataIsZero, complete bool, err error) error {
	if complete || err != nil {
		if c.localCompleted.Swap(true) {
			// Repeated completion is an idempotent no-op.
			if complete && len(data) == 0 && !dataIsZero {
				return nil
			}
			return ErrCompleted
		}
	} else if c.localCompleted.Load() {
		return ErrCompleted
	}

	outPkt := NewCallDataPacket(data, len(data) == 0 && dataIsZero, complete, err)
	return c.writer.WritePacket(outPkt)
}

// HandleStreamClose handles the incoming stream closing w/ optional error.
func (c *commonRPC) HandleStreamClose(closeErr error) {
	locked := c.bcast.Lock()
	writer := c.handleStreamCloseLocked(&locked, closeErr)
	locked.Unlock()
	if writer != nil {
		_ = writer.Close()
	}
}

// HandleCallCancel handles the call cancel packet.
func (c *commonRPC) HandleCallCancel() error {
	locked := c.bcast.Lock()
	if (!c.dataClosed || !c.writerClosed) && !c.remoteTerminalSet {
		c.remoteCanceled = true
	}
	writer := c.handleStreamCloseLocked(&locked, context.Canceled)
	locked.Unlock()
	if writer != nil {
		_ = writer.Close()
	}
	return nil
}

// HandleCallData handles the call data packet.
func (c *commonRPC) HandleCallData(pkt *CallData) error {
	var err error
	locked := c.bcast.Lock()
	if c.dataClosed {
		// If the packet is just indicating the call is complete, ignore it.
		if !pkt.GetComplete() {
			// Otherwise, return ErrCompleted (unexpected packet).
			err = ErrCompleted
		}
		locked.Unlock()
		return err
	}

	if data := pkt.GetData(); len(data) != 0 || pkt.GetDataIsZero() {
		c.dataQueue = append(c.dataQueue, data)
	}

	pktErr := pkt.GetError()
	complete := pkt.GetComplete()
	if len(pktErr) != 0 {
		complete = true
		if c.remoteErr == nil {
			c.remoteErr = errors.New(pktErr)
		}
	}

	if complete {
		c.dataClosed = true
		if len(pktErr) == 0 {
			if c.recordRemoteTerminalLocked(TerminalCommitted) {
				c.remoteCompleted = true
			}
		} else {
			c.recordRemoteTerminalLocked(TerminalLost)
		}
	}

	locked.Broadcast()
	locked.Unlock()

	return err
}

func (c *commonRPC) recordRemoteTerminalLocked(kind TerminalKind) bool {
	if c.remoteTerminalSet {
		return false
	}
	c.remoteTerminal = kind
	c.remoteTerminalSet = true
	return true
}

func (c *commonRPC) handleStreamCloseLocked(
	locked *broadcast.Locked,
	closeErr error,
) PacketWriter {
	if c.dataClosed && c.writerClosed {
		return nil
	}
	normalRemoteCloseAfterLocalComplete := closeErr == nil && (c.localCompleting || c.localDone)
	if closeErr != nil && c.remoteErr == nil {
		c.remoteErr = closeErr
	}
	if !normalRemoteCloseAfterLocalComplete && !c.remoteTerminalSet {
		terminal := TerminalClosed
		if closeErr != nil {
			terminal = TerminalLost
			if c.remoteCanceled {
				terminal = TerminalCanceled
			}
		}
		c.recordRemoteTerminalLocked(terminal)
	}
	c.dataClosed = true
	if !normalRemoteCloseAfterLocalComplete {
		c.cancelContext()
		writer := c.closeWriterLocked()
		locked.Broadcast()
		return writer
	}
	locked.Broadcast()
	return nil
}

// WriteCallCancel writes a call cancel packet.
func (c *commonRPC) WriteCallCancel() error {
	// Use atomic swap to check and set completion atomically
	if c.localCompleted.Swap(true) {
		return ErrCompleted
	}

	return c.writer.WritePacket(NewCallCancelPacket())
}

// closeLocked releases resources held by the RPC.
func (c *commonRPC) closeLocked(locked *broadcast.Locked) PacketWriter {
	c.dataClosed = true
	c.localCompleted.Store(true)
	if c.remoteErr == nil {
		c.remoteErr = context.Canceled
	}
	writer := c.closeWriterLocked()
	locked.Broadcast()
	c.cancelContext()
	return writer
}

func (c *commonRPC) closeWriterLocked() PacketWriter {
	if c.writerClosed || c.writer == nil {
		return nil
	}
	c.writerClosed = true
	return c.writer
}

func (c *commonRPC) beginLocalCompletion() {
	locked := c.bcast.Lock()
	c.localCompleted.Store(true)
	c.localCompleting = true
	locked.Unlock()
}

func (c *commonRPC) finishLocalCompletion() {
	locked := c.bcast.Lock()
	c.localCompleted.Store(true)
	writer := c.closeWriterLocked()
	locked.Unlock()
	if writer != nil {
		_ = writer.Close()
	}
	locked = c.bcast.Lock()
	c.localCompleting = false
	c.localActive = false
	c.localDone = true
	locked.Broadcast()
	locked.Unlock()
}
