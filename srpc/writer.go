package srpc

// PacketWriter is the interface used to write messages to a PacketStream.
type PacketWriter interface {
	// WritePacket writes a packet to the remote.
	WritePacket(p *Packet) error
	// Close closes the writer.
	Close() error
}

// packetWriterWithClose is a PacketWriter with a wrapped Close function.
type packetWriterWithClose struct {
	PacketWriter
	closeFn func() error
}

// NewPacketWriterWithClose wraps a PacketWriter with a close function to call when Close is called.
func NewPacketWriterWithClose(prw PacketWriter, close func() error) PacketWriter {
	return &packetWriterWithClose{PacketWriter: prw, closeFn: close}
}

// Close closes the stream for reading and writing.
func (s *packetWriterWithClose) Close() error {
	err := s.PacketWriter.Close()
	err2 := s.closeFn()
	if err != nil {
		return err
	}
	return err2
}

// _ is a type assertion
var _ PacketWriter = (*packetWriterWithClose)(nil)
