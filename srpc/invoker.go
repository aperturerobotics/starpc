package srpc

// Invoker is a function for invoking SRPC service methods.
type Invoker interface {
	// InvokeMethod invokes the method matching the service & method ID.
	// Returns false, nil if not found.
	// If service string is empty, ignore it.
	InvokeMethod(serviceID, methodID string, strm Stream) (bool, error)
}
