package srpc

// Conn represents a connection to a remote.
type Conn interface {
	// GetOpenStreamFunc returns the OpenStream func.
	GetOpenStreamFunc() OpenStreamFunc
}
