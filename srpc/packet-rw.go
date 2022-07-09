package srpc

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"

	"github.com/pkg/errors"
)

// maxMessageSize is the max message size in bytes
var maxMessageSize = 1e7

// PacketReaderWriter reads and writes packets from a io.ReadWriter.
// Uses a LittleEndian uint32 length prefix.
type PacketReaderWriter struct {
	// rw is the io.ReadWriterCloser
	rw io.ReadWriteCloser
	// buf is the buffered data
	buf bytes.Buffer
}

// NewPacketReadWriter constructs a new read/writer.
func NewPacketReadWriter(rw io.ReadWriteCloser) *PacketReaderWriter {
	return &PacketReaderWriter{rw: rw}
}

// WritePacket writes a packet to the writer.
func (r *PacketReaderWriter) WritePacket(p *Packet) error {
	msgSize := p.SizeVT()
	data := make([]byte, 4+msgSize)
	binary.LittleEndian.PutUint32(data, uint32(msgSize))
	_, err := p.MarshalToVT(data[4:])
	if err != nil {
		return err
	}
	_, err = r.rw.Write(data)
	return err
}

// ReadPump executes the read pump in a goroutine.
//
// calls the handler when closed or returning an error
func (r *PacketReaderWriter) ReadPump(cb PacketHandler, closed CloseHandler) {
	err := r.ReadToHandler(cb)
	// signal that the stream is now closed.
	if closed != nil {
		closed(err)
	}
}

// ReadToHandler reads data to the given handler.
// Does not handle closing the stream, use ReadPump instead.
func (r *PacketReaderWriter) ReadToHandler(cb PacketHandler) error {
	var currLen uint32
	buf := make([]byte, 2048)
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

		// check if we have enough data for a length prefix
		bufLen := r.buf.Len()
		if bufLen < 4 {
			continue
		}

		// parse the length prefix if not done already
		if currLen == 0 {
			currLen = r.readLengthPrefix(r.buf.Bytes())
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
			npkt := &Packet{}
			if err := npkt.UnmarshalVT(pkt); err != nil {
				return err
			}
			if err := cb(npkt); err != nil {
				return err
			}
		}
	}

	// closed
	return nil
}

// Close closes the packet rw.
func (r *PacketReaderWriter) Close() error {
	return r.rw.Close()
}

// readLengthPrefix reads the length prefix.
func (r *PacketReaderWriter) readLengthPrefix(b []byte) uint32 {
	if len(b) < 4 {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

// _ is a type assertion
var _ Writer = (*PacketReaderWriter)(nil)
