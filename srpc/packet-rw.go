package srpc

import (
	"bytes"
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
func (r *PacketReaderWriter) ReadPump(cb PacketHandler) error {
	var currLen uint32
	buf := make([]byte, 2048)
	for {
		n, err := r.rw.Read(buf)
		if err != nil {
			if err == io.EOF {
				err = nil
			}
			return err
		}
		_, err = r.buf.Write(buf[:n])
		if err != nil {
			return err
		}

		// check if we have enough for a length prefix
		bufLen := r.buf.Len()
		if currLen == 0 {
			if bufLen < 4 {
				continue
			}
			currLen = r.readLengthPrefix(r.buf.Bytes())
			if currLen == 0 {
				return errors.New("unexpected zero len prefix")
			}
			if currLen > uint32(maxMessageSize) {
				return errors.Errorf("message size %v greater than maximum %v", currLen, maxMessageSize)
			}
		}
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
