package srpc

// PacketWriter is the interface used to write messages to a PacketStream.
type PacketWriter interface {
	// WritePacket writes a packet to the remote.
	WritePacket(p *Packet) error
	// Close closes the writer.
	Close() error
}

// PacketMessageWriter is a PacketWriter that encodes a packet directly into
// the buffer it sends, so a packet that wraps a message need not copy it first.
type PacketMessageWriter interface {
	PacketWriter
	// WritePacketMessage writes the encoded Packet to the remote. The packet
	// is encoded before the call returns and is not retained.
	WritePacketMessage(pkt SizedMessage) error
}

// packetWriterWithClose is a PacketWriter with a wrapped Close function.
type packetWriterWithClose struct {
	PacketWriter
	closeFn func() error
}

// packetMessageWriterWithClose is a PacketMessageWriter with a wrapped Close function.
type packetMessageWriterWithClose struct {
	PacketMessageWriter
	closeFn func() error
}

// NewPacketWriterWithClose wraps a PacketWriter with a close function to call when Close is called.
//
// The result is a PacketMessageWriter when prw is one.
func NewPacketWriterWithClose(prw PacketWriter, close func() error) PacketWriter {
	if pmw, ok := prw.(PacketMessageWriter); ok {
		return &packetMessageWriterWithClose{PacketMessageWriter: pmw, closeFn: close}
	}
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

// Close closes the stream for reading and writing.
func (s *packetMessageWriterWithClose) Close() error {
	err := s.PacketMessageWriter.Close()
	err2 := s.closeFn()
	if err != nil {
		return err
	}
	return err2
}

// _ is a type assertion
var (
	_ PacketWriter        = (*packetWriterWithClose)(nil)
	_ PacketMessageWriter = (*packetMessageWriterWithClose)(nil)
)
