package srpc

// Writer is the interface used to write messages to the remote.
type Writer interface {
	// MsgSend sends the message to the remote.
	MsgSend(msg Message) error
	// Close closes the writer.
	Close() error
}
