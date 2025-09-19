package srpc

// Invoker is a function for invoking SRPC service methods.
type Invoker interface {
	// InvokeMethod invokes the method matching the service & method ID.
	// Returns false, nil if not found.
	// If service string is empty, ignore it.
	InvokeMethod(serviceID, methodID string, strm Stream) (bool, error)
}

// QueryableInvoker can be used to check if a service and method is implemented.
type QueryableInvoker interface {
	// HasService checks if the service ID exists in the handlers.
	HasService(serviceID string) bool
	// HasServiceMethod checks if <service-id, method-id> exists in the handlers.
	HasServiceMethod(serviceID, methodID string) bool
}

// InvokerSlice is a list of invokers.
type InvokerSlice []Invoker

// InvokeMethod invokes the method matching the service & method ID.
// Returns false, nil if not found.
// If service string is empty, ignore it.
func (s InvokerSlice) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	for _, invoker := range s {
		if invoker == nil {
			continue
		}

		found, err := invoker.InvokeMethod(serviceID, methodID, strm)
		if found || err != nil {
			return true, err
		}
	}
	return false, nil
}

// _ is a type assertion
var _ Invoker = (InvokerSlice)(nil)

// InvokerFunc is a function implementing InvokeMethod.
type InvokerFunc func(serviceID, methodID string, strm Stream) (bool, error)

// InvokeMethod invokes the method matching the service & method ID.
// Returns false, nil if not found.
// If service string is empty, ignore it.
func (f InvokerFunc) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	if f == nil {
		return false, nil
	}
	return f(serviceID, methodID, strm)
}

var _ Invoker = (InvokerFunc)(nil)
