package srpc

import (
	"context"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// connPktSize is the size of the buffers to use for packets for the RwcConn.
const connPktSize = 2048

// bufPool is a channel-based buffer pool with predictable reuse behavior.
type bufPool struct {
	ch   chan []byte
	size int
}

func newBufPool(poolSize, bufSize int) *bufPool {
	return &bufPool{
		ch:   make(chan []byte, poolSize),
		size: bufSize,
	}
}

func (p *bufPool) get() []byte {
	select {
	case b := <-p.ch:
		return b[:p.size]
	default:
		return make([]byte, p.size)
	}
}

func (p *bufPool) put(b []byte) {
	select {
	case p.ch <- b:
	default:
	}
}

// RwcConn implements a net.Conn with a buffered ReadWriteCloser.
type RwcConn struct {
	ctx       context.Context
	ctxCancel context.CancelFunc
	rwc       io.ReadWriteCloser
	laddr     net.Addr
	raddr     net.Addr

	pool     *bufPool
	packetCh chan []byte

	mu       sync.Mutex
	rd       time.Time
	wd       time.Time
	closeErr error

	pendingMu sync.Mutex
	pending   []byte
}

// NewRwcConn constructs a new RwcConn and starts the rx pump.
func NewRwcConn(
	ctx context.Context,
	rwc io.ReadWriteCloser,
	laddr, raddr net.Addr,
	bufferPacketN int,
) *RwcConn {
	ctx, ctxCancel := context.WithCancel(ctx)
	if bufferPacketN <= 0 {
		bufferPacketN = 10
	}

	c := &RwcConn{
		ctx:       ctx,
		ctxCancel: ctxCancel,
		rwc:       rwc,
		laddr:     laddr,
		raddr:     raddr,
		pool:      newBufPool(bufferPacketN, connPktSize),
		packetCh:  make(chan []byte, bufferPacketN),
	}
	go c.rxPump()
	return c
}

// LocalAddr returns the local network address.
func (p *RwcConn) LocalAddr() net.Addr {
	return p.laddr
}

// RemoteAddr returns the bound remote network address.
func (p *RwcConn) RemoteAddr() net.Addr {
	return p.raddr
}

// readDeadline returns the current read deadline under the mutex.
func (p *RwcConn) readDeadline() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rd
}

// getCloseErr returns the close error under the mutex.
func (p *RwcConn) getCloseErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closeErr
}

// setCloseErr stores the close error under the mutex.
func (p *RwcConn) setCloseErr(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeErr = err
}

// Read reads data from the connection.
// Read can be made to time out and return an error after a fixed
// time limit; see SetDeadline and SetReadDeadline.
func (p *RwcConn) Read(b []byte) (int, error) {
	// Drain pending data from a previous partial read first.
	p.pendingMu.Lock()
	if len(p.pending) > 0 {
		n := copy(b, p.pending)
		if n < len(p.pending) {
			p.pending = p.pending[n:]
		} else {
			p.pending = nil
		}
		p.pendingMu.Unlock()
		return n, nil
	}
	p.pendingMu.Unlock()

	// Build a context with the read deadline if one is set.
	ctx := p.ctx
	deadline := p.readDeadline()
	if !deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}

	select {
	case <-ctx.Done():
		if !deadline.IsZero() {
			return 0, os.ErrDeadlineExceeded
		}
		return 0, context.Canceled
	case pkt, ok := <-p.packetCh:
		if !ok {
			err := p.getCloseErr()
			if err == nil {
				err = io.EOF
			}
			return 0, err
		}

		n := copy(b, pkt)
		if n < len(pkt) {
			// Buffer the remaining bytes for the next Read call.
			// Explicitly copy so the pool buffer is not aliased.
			p.pendingMu.Lock()
			p.pending = append(p.pending[:0], pkt[n:]...)
			p.pendingMu.Unlock()
		}
		p.pool.put(pkt)
		return n, nil
	}
}

// Write writes data to the connection.
func (p *RwcConn) Write(pkt []byte) (int, error) {
	if len(pkt) == 0 {
		return 0, nil
	}

	written := 0
	for written < len(pkt) {
		n, err := p.rwc.Write(pkt[written:])
		written += n
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

// SetDeadline sets the read and write deadlines associated with the
// connection. It is equivalent to calling both SetReadDeadline and
// SetWriteDeadline.
//
// A zero value for t means I/O operations will not time out.
func (p *RwcConn) SetDeadline(t time.Time) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rd = t
	p.wd = t
	return nil
}

// SetReadDeadline sets the deadline for future Read calls and any
// currently-blocked Read call.
// A zero value for t means Read will not time out.
func (p *RwcConn) SetReadDeadline(t time.Time) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rd = t
	return nil
}

// SetWriteDeadline sets the deadline for future Write calls and any
// currently-blocked Write call.
// A zero value for t means Write will not time out.
func (p *RwcConn) SetWriteDeadline(t time.Time) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.wd = t
	return nil
}

// Close closes the connection.
// Any blocked Read or Write operations will be unblocked and return errors.
func (p *RwcConn) Close() error {
	p.ctxCancel()
	return p.rwc.Close()
}

// rxPump receives messages from the underlying connection.
func (p *RwcConn) rxPump() {
	var rerr error
	defer func() {
		p.setCloseErr(rerr)
		close(p.packetCh)
	}()

	for {
		buf := p.pool.get()
		n, err := p.rwc.Read(buf)
		if n == 0 {
			p.pool.put(buf)
		} else {
			select {
			case <-p.ctx.Done():
				p.pool.put(buf)
				rerr = context.Canceled
				return
			case p.packetCh <- buf[:n]:
			}
		}
		if err != nil {
			rerr = err
			return
		}
	}
}

// _ is a type assertion
var _ net.Conn = (*RwcConn)(nil)
