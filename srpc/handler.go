package srpc

// Handler describes a SRPC call handler implementation.
type Handler interface {
	// Invoker invokes the methods.
	Invoker

	// GetServiceID returns the ID of the service.
	GetServiceID() string
	// GetMethodIDs returns the list of methods for the service.
	GetMethodIDs() []string
}
