package srpc

// PacketWriter is the interface used to write messages to a PacketStream.
type PacketWriter interface {
	// WritePacket writes a packet to the remote.
	WritePacket(p *Packet) error
	// Close closes the writer.
	Close() error
}
