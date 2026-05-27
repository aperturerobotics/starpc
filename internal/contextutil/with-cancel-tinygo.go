//go:build tinygo

package contextutil

import (
	"context"
	"sync"
	"time"
)

type cancelBridgeContext struct {
	context.Context
	parent context.Context
	mu     sync.Mutex
	err    error
}

func (c *cancelBridgeContext) Deadline() (time.Time, bool) {
	return c.parent.Deadline()
}

func (c *cancelBridgeContext) Err() error {
	c.mu.Lock()
	err := c.err
	c.mu.Unlock()
	if err != nil {
		return err
	}
	return c.Context.Err()
}

func (c *cancelBridgeContext) setErr(err error) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return false
	}
	c.err = err
	return true
}

// WithCancel returns a cancelable child context.
func WithCancel(parent context.Context) (context.Context, context.CancelFunc) {
	base := context.WithoutCancel(parent)
	ctx, cancelCause := context.WithCancelCause(base)
	bridge := &cancelBridgeContext{Context: ctx, parent: parent}
	ctx = bridge
	cancelFrom := func(err, cause error) {
		if !bridge.setErr(err) {
			return
		}
		cancelCause(cause)
	}
	cancelFromParent := func() {
		cancelFrom(parent.Err(), context.Cause(parent))
	}
	cancel := func() {
		cancelFrom(context.Canceled, context.Canceled)
	}
	parentDone := parent.Done()
	if parentDone == nil {
		return ctx, cancel
	}
	select {
	case <-parentDone:
		cancelFromParent()
		return ctx, cancel
	default:
	}

	// TinyGo 0.41 has staging-proven traps in cancelCtx child-map hashing while
	// opening SRPC stream fanout. Keep the child off the parent map and bridge
	// cancellation through StarPC-owned channel state.
	go func() {
		select {
		case <-parentDone:
			cancelFromParent()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}
