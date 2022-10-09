package srpc

import "sync"

// Mux contains a set of <service, method> handlers.
type Mux interface {
	// Invoker invokes the methods.
	Invoker

	// Register registers a new RPC method handler (service).
	Register(handler Handler) error
	// HasService checks if the service ID exists in the handlers.
	HasService(serviceID string) bool
	// HasServiceMethod checks if <service-id, method-id> exists in the handlers.
	HasServiceMethod(serviceID, methodID string) bool
}

// muxMethods is a mapping from method id to handler.
type muxMethods map[string]Handler

// mux is the default implementation of Mux.
type mux struct {
	// rmtx guards below fields
	rmtx sync.RWMutex
	// services contains a mapping from services to handlers.
	services map[string]muxMethods
}

// NewMux constructs a new Mux.
func NewMux() Mux {
	return &mux{services: make(map[string]muxMethods)}
}

// Register registers a new RPC method handler (service).
func (m *mux) Register(handler Handler) error {
	serviceID := handler.GetServiceID()
	methodIDs := handler.GetMethodIDs()
	if serviceID == "" {
		return ErrEmptyServiceID
	}

	m.rmtx.Lock()
	defer m.rmtx.Unlock()

	serviceMethods := m.services[serviceID]
	if serviceMethods == nil {
		serviceMethods = make(muxMethods)
		m.services[serviceID] = serviceMethods
	}
	for _, methodID := range methodIDs {
		if methodID != "" {
			serviceMethods[methodID] = handler
		}
	}

	return nil
}

// HasService checks if the service ID exists in the handlers.
func (m *mux) HasService(serviceID string) bool {
	if serviceID == "" {
		return false
	}

	m.rmtx.Lock()
	defer m.rmtx.Unlock()

	return len(m.services[serviceID]) != 0
}

// HasServiceMethod checks if <service-id, method-id> exists in the handlers.
func (m *mux) HasServiceMethod(serviceID, methodID string) bool {
	if serviceID == "" || methodID == "" {
		return false
	}

	m.rmtx.Lock()
	defer m.rmtx.Unlock()

	handlers := m.services[serviceID]
	for _, mh := range handlers {
		for _, mhMethodID := range mh.GetMethodIDs() {
			if mhMethodID == methodID {
				return true
			}
		}
	}

	return false
}

// InvokeMethod invokes the method matching the service & method ID.
// Returns false, nil if not found.
// If service string is empty, ignore it.
func (m *mux) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	var handler Handler
	m.rmtx.RLock()
	svcMethods := m.services[serviceID]
	if svcMethods != nil {
		handler = svcMethods[methodID]
	}
	m.rmtx.RUnlock()

	if handler == nil {
		return false, nil
	}

	return handler.InvokeMethod(serviceID, methodID, strm)
}

// _ is a type assertion
var _ Mux = ((*mux)(nil))
