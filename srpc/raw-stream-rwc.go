package srpc

import (
	"context"
	"io"
	"sync"

	"github.com/aperturerobotics/util/broadcast"
)

// RawStreamRwc implements io.ReadWriteCloser with a raw stream.
type RawStreamRwc struct {
	// writer is used to write messages to the remote.
	writer Writer
	// mtx guards below fields
	mtx sync.Mutex
	// bcast is broadcasted when data is added to readQueue
	bcast broadcast.Broadcast
	// readQueue holds incoming data to read
	readQueue [][]byte
	// closed indicates whether the stream is closed
	closed bool
	// closeErr stores the error, if any, when closing the stream
	closeErr error
}

func NewRawStreamRwc(ctx context.Context, ctorFn RawStreamCtor) (*RawStreamRwc, error) {
	rwc := &RawStreamRwc{}
	var err error
	rwc.writer, err = ctorFn(ctx, rwc.handlePacketData, rwc.handleClose)
	if err != nil {
		return nil, err
	}
	return rwc, nil
}

// handlePacketData implements PacketDataHandler.
func (r *RawStreamRwc) handlePacketData(pkt []byte) error {
	r.mtx.Lock()
	defer r.mtx.Unlock()

	if r.closed {
		return io.ErrClosedPipe
	}

	r.readQueue = append(r.readQueue, pkt)
	r.bcast.Broadcast()
	return nil
}

// handleClose handles the stream closing with an optional error.
func (r *RawStreamRwc) handleClose(closeErr error) {
	r.mtx.Lock()
	defer r.mtx.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	r.closeErr = closeErr
	r.bcast.Broadcast()
}

// Read reads data from the stream to p.
// Implements io.Reader.
func (r *RawStreamRwc) Read(p []byte) (n int, err error) {
	readBuf := p
	for len(readBuf) != 0 && err == nil {
		// if the buffer has data, read from it.
		var rn int
		var read []byte

		r.mtx.Lock()
		if len(r.readQueue) != 0 {
			nrq := r.readQueue[0]
			// rn = amount of data to read
			// minimum of len(readBuf) (length of space remaining in p) and len(nrq) (size of next pkt in read queue)
			rn = min(len(readBuf), len(nrq))
			// read the contents of nrq up to rn bytes
			read = nrq[:rn]
			// get the remainder of the packet that we won't read this time
			nrq = nrq[rn:]
			// if there is no more to read drop the pkt from the queue
			if len(nrq) == 0 {
				r.readQueue[0] = nil
				r.readQueue = r.readQueue[1:]
			} else {
				// otherwise update the queued packet to be just the remainder
				r.readQueue[0] = nrq
			}
		}

		// check if the stream is closed
		closed, closedErr := r.closed, r.closeErr
		var wait <-chan struct{}

		// if we didn't read anything and !closed, wait till something changes.
		if rn == 0 && !closed {
			wait = r.bcast.GetWaitCh()
		}
		r.mtx.Unlock()

		// if we read data, copy it to the output buf
		if rn != 0 {
			// copy data to output buf
			copy(readBuf, read)
			n += rn
			// advance readBuf by rn
			readBuf = readBuf[rn:]
			continue
		}

		// if we read data to p already, return now.
		if n != 0 {
			break
		}

		// if closed or error, return.
		if closed {
			if closedErr != nil {
				return n, closedErr
			}
			return n, io.EOF
		}

		// wait for data or closed
		<-wait
	}

	return n, err
}

// Write writes data to the stream.
func (r *RawStreamRwc) Write(p []byte) (int, error) {
	return r.writer.Write(p)
}

// WritePacket writes a packet to the remote.
func (r *RawStreamRwc) WritePacket(p *Packet) error {
	return r.writer.WritePacket(p)
}

// Close closes the stream.
func (r *RawStreamRwc) Close() error {
	r.mtx.Lock()
	defer r.mtx.Unlock()

	if r.closed {
		return r.closeErr
	}

	r.closed = true
	r.closeErr = r.writer.Close()
	r.bcast.Broadcast()
	return r.closeErr
}

// _ is a type assertion
var (
	_ io.ReadWriteCloser = ((*RawStreamRwc)(nil))
	_ Writer             = ((*RawStreamRwc)(nil))
)
