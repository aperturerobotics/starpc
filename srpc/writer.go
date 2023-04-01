package srpc

// Writer is the interface used to write messages to the remote.
type Writer interface {
	// Write writes raw data to the remote.
	Write(p []byte) (n int, err error)
	// WritePacket writes a packet to the remote.
	WritePacket(p *Packet) error
	// Close closes the writer.
	Close() error
}
