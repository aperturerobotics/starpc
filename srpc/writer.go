package srpc

// Writer is the interface used to write messages to the remote.
type Writer interface {
	// WritePacket writes a packet to the remote.
	WritePacket(p *Packet) error
	// Close closes the writer.
	Close() error
}
