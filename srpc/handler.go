package srpc

// Invoker describes a SRPC service invoker.
type Invoker interface {
	// InvokeMethod invokes the method matching the service & method ID.
	// Returns false, nil if not found.
	// If service string is empty, ignore it.
	InvokeMethod(serviceID, methodID string, strm Stream) (bool, error)
}

// Handler describes a SRPC call handler implementation.
type Handler interface {
	// Invoker invokes the methods.
	Invoker

	// GetServiceID returns the ID of the service.
	GetServiceID() string
	// GetMethodIDs returns the list of methods for the service.
	GetMethodIDs() []string
}
