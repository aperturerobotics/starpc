package srpc

import "strings"

// Invoker is a function for invoking SRPC service methods.
type Invoker interface {
	// InvokeMethod invokes the method matching the service & method ID.
	// Returns false, nil if not found.
	// If service string is empty, ignore it.
	InvokeMethod(serviceID, methodID string, strm Stream) (bool, error)
}

// PrefixInvoker checks for and strips a set of prefixes from a Invoker.
type PrefixInvoker struct {
	// inv is the underlying invoker
	inv Invoker
	// serviceIDPrefixes is the list of service id prefixes to match.
	// strips the prefix before calling the underlying Invoke
	// if empty: forwards all services w/o stripping any prefix.
	serviceIDPrefixes []string
}

// NewPrefixInvoker constructs a new PrefixInvoker.
func NewPrefixInvoker(inv Invoker, serviceIDPrefixes []string) *PrefixInvoker {
	return &PrefixInvoker{
		inv:               inv,
		serviceIDPrefixes: serviceIDPrefixes,
	}
}

// InvokeMethod invokes the method matching the service & method ID.
// Returns false, nil if not found.
// If service string is empty, ignore it.
func (i *PrefixInvoker) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	if serviceIDPrefixes := i.serviceIDPrefixes; len(serviceIDPrefixes) != 0 {
		var matched bool
		var stripPrefix string
		for _, prefix := range serviceIDPrefixes {
			matched = strings.HasPrefix(serviceID, prefix)
			if matched {
				stripPrefix = prefix
				break
			}
		}
		if !matched {
			return false, nil
		}
		serviceID = serviceID[len(stripPrefix):]
	}

	return i.inv.InvokeMethod(serviceID, methodID, strm)
}

// _ is a type assertion
var _ Invoker = ((*PrefixInvoker)(nil))
