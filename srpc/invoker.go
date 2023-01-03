package srpc

// Invoker is a function for invoking SRPC service methods.
type Invoker interface {
	// InvokeMethod invokes the method matching the service & method ID.
	// Returns false, nil if not found.
	// If service string is empty, ignore it.
	InvokeMethod(serviceID, methodID string, strm Stream) (bool, error)
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
