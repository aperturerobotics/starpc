package srpc

// PrefixInvoker checks for and strips a set of prefixes from a Invoker.
type PrefixInvoker struct {
	// inv is the underlying invoker
	inv Invoker
	// serviceIDPrefixes is the list of service id prefixes to match.
	serviceIDPrefixes []string
}

// NewPrefixInvoker constructs a new PrefixInvoker.
//
// serviceIDPrefixes is the list of service id prefixes to match.
// strips the prefix before calling the underlying Invoke function.
// if none of the prefixes match, returns unimplemented.
// if empty: forwards all services w/o stripping any prefix.
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
	if len(i.serviceIDPrefixes) != 0 {
		strippedID, matchedPrefix := CheckStripPrefix(serviceID, i.serviceIDPrefixes)
		if len(matchedPrefix) == 0 {
			return false, nil
		}
		serviceID = strippedID
	}

	return i.inv.InvokeMethod(serviceID, methodID, strm)
}

// _ is a type assertion
var _ Invoker = ((*PrefixInvoker)(nil))
