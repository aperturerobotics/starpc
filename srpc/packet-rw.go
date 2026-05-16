package srpc

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"sync"

	"github.com/pkg/errors"
)

const (
	// maxMessageSize is the max message size in bytes.
	maxMessageSize = 10_000_000
	// readBufferSize is the packet read scratch buffer size.
	readBufferSize = 2048
	// pooledWriteBufferMaxSize is the largest outbound frame buffer to pool.
	pooledWriteBufferMaxSize = 64 * 1024
)

var (
	readBufferPool = sync.Pool{
		New: func() any {
			return new([readBufferSize]byte)
		},
	}
	writeBufferPool = sync.Pool{
		New: func() any {
			return new(writeBuffer)
		},
	}
)

type writeBuffer struct {
	data []byte
}

// PacketReadWriter reads and writes packets from a io.ReadWriter.
// Uses a LittleEndian uint32 length prefix.
type PacketReadWriter struct {
	// rw is the io.ReadWriterCloser
	rw io.ReadWriteCloser
	// buf is the buffered data
	buf bytes.Buffer
	// writeMtx is the write mutex
	writeMtx sync.Mutex
}

// NewPacketReadWriter constructs a new read/writer.
func NewPacketReadWriter(rw io.ReadWriteCloser) *PacketReadWriter {
	return &PacketReadWriter{rw: rw}
}

// Write writes raw data to the remote.
func (r *PacketReadWriter) Write(p []byte) (n int, err error) {
	r.writeMtx.Lock()
	defer r.writeMtx.Unlock()
	return r.rw.Write(p)
}

// WritePacket writes a packet to the writer.
func (r *PacketReadWriter) WritePacket(p *Packet) error {
	r.writeMtx.Lock()
	defer r.writeMtx.Unlock()

	msgSize := p.SizeVT()
	if msgSize < 0 || msgSize > maxMessageSize {
		return errors.Errorf("message size %v greater than maximum %v", msgSize, maxMessageSize)
	}

	writeBuf := getWriteBuffer(4 + msgSize)
	defer putWriteBuffer(writeBuf)
	data := writeBuf.data
	binary.LittleEndian.PutUint32(data, uint32(msgSize)) //nolint:gosec

	_, err := p.MarshalToSizedBufferVT(data[4:])
	if err != nil {
		return err
	}

	var written, n int
	for written < len(data) {
		n, err = r.rw.Write(data[written:])
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		written += n
	}

	return nil
}

// ReadPump executes the read pump in a goroutine.
//
// calls the handler when closed or returning an error
func (r *PacketReadWriter) ReadPump(cb PacketDataHandler, closed CloseHandler) {
	err := r.ReadToHandler(cb)
	// signal that the stream is now closed.
	if closed != nil {
		closed(err)
	}
}

// ReadToHandler reads data to the given handler.
// Does not handle closing the stream, use ReadPump instead.
func (r *PacketReadWriter) ReadToHandler(cb PacketDataHandler) error {
	var currLen uint32
	bufPtr := readBufferPool.Get().(*[readBufferSize]byte)
	defer readBufferPool.Put(bufPtr)
	buf := bufPtr[:]
	isOpen := true

	for isOpen {
		// read some data into the buffer
		n, err := r.rw.Read(buf)
		if err != nil {
			if err == io.EOF || err == context.Canceled {
				isOpen = false
			} else {
				return err
			}
		}

		// push the data to r.buf
		_, err = r.buf.Write(buf[:n])
		if err != nil {
			return err
		}

	EmitIfEnough:

		// check if we have enough data for a length prefix
		bufLen := r.buf.Len()
		if bufLen < 4 {
			continue
		}

		// parse the length prefix if not done already
		if currLen == 0 {
			currLen = r.readLengthPrefix(r.buf.Bytes()[:4])
			if currLen == 0 {
				return errors.New("unexpected zero len prefix")
			}
			if currLen > uint32(maxMessageSize) {
				return errors.Errorf("message size %v greater than maximum %v", currLen, maxMessageSize)
			}
		}

		// emit the packet if fully buffered
		if currLen != 0 && bufLen >= int(currLen)+4 {
			pkt := r.buf.Next(int(currLen + 4))[4:]
			currLen = 0
			if err := cb(pkt); err != nil {
				return err
			}

			// check if there's still enough in the buffer
			goto EmitIfEnough
		}
	}

	// closed
	return nil
}

// Close closes the packet rw.
func (r *PacketReadWriter) Close() error {
	return r.rw.Close()
}

// readLengthPrefix reads the length prefix.
func (r *PacketReadWriter) readLengthPrefix(b []byte) uint32 {
	if len(b) < 4 {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

func getWriteBuffer(size int) *writeBuffer {
	if size > pooledWriteBufferMaxSize {
		return &writeBuffer{data: make([]byte, size)}
	}
	buf := writeBufferPool.Get().(*writeBuffer)
	if cap(buf.data) < size {
		buf.data = make([]byte, size)
	}
	buf.data = buf.data[:size]
	return buf
}

func putWriteBuffer(buf *writeBuffer) {
	if cap(buf.data) <= pooledWriteBufferMaxSize {
		clear(buf.data)
		buf.data = buf.data[:0]
		writeBufferPool.Put(buf)
	}
}

// _ is a type assertion
var _ PacketWriter = (*PacketReadWriter)(nil)
