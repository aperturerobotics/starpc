package srpc

import (
	"time"

	"github.com/sirupsen/logrus"
)

// VMux implements a verbose logging wrapper for a Mux.
type VMux struct {
	mx          Mux
	le          *logrus.Entry
	veryVerbose bool
}

// NewVMux constructs a verbose logging wrapper for a Mux.
//
// if veryVerbose is set, we also log very chatty logs: HasService, HasServiceMethod, Register
func NewVMux(mux Mux, le *logrus.Entry, veryVerbose bool) *VMux {
	return &VMux{mx: mux, le: le, veryVerbose: veryVerbose}
}

// InvokeMethod invokes the method matching the service & method ID.
// Returns false, nil if not found.
// If service string is empty, ignore it.
func (v *VMux) InvokeMethod(serviceID, methodID string, strm Stream) (done bool, err error) {
	t1 := time.Now()
	v.le.Debugf(
		"InvokeMethod(serviceID(%s), methodID(%s)) => started",
		serviceID,
		methodID,
	)
	defer func() {
		v.le.Debugf(
			"InvokeMethod(serviceID(%s), methodID(%s)) => dur(%v) done(%v) err(%v)",
			serviceID,
			methodID,
			time.Since(t1).String(),
			done,
			err,
		)
	}()
	return v.mx.InvokeMethod(serviceID, methodID, strm)
}

// Register registers a new RPC method handler (service).
func (v *VMux) Register(handler Handler) (err error) {
	if v.veryVerbose {
		t1 := time.Now()
		defer func() {
			v.le.Debugf(
				"Register(handler(%v)) => dur(%v) err(%v)",
				handler,
				time.Since(t1).String(),
				err,
			)
		}()
	}
	return v.mx.Register(handler)
}

// HasService checks if the service ID exists in the handlers.
func (v *VMux) HasService(serviceID string) (has bool) {
	if v.veryVerbose {
		t1 := time.Now()
		defer func() {
			v.le.Debugf(
				"HasService(serviceID(%s)) => dur(%v) has(%v)",
				serviceID,
				time.Since(t1).String(),
				has,
			)
		}()
	}
	return v.mx.HasService(serviceID)
}

// HasServiceMethod checks if <service-id, method-id> exists in the handlers.
func (v *VMux) HasServiceMethod(serviceID, methodID string) (has bool) {
	if v.veryVerbose {
		t1 := time.Now()
		defer func() {
			v.le.Debugf(
				"HasServiceMethod(serviceID(%s), methodID(%s)) => dur(%v) has(%v)",
				serviceID,
				methodID,
				time.Since(t1).String(),
				has,
			)
		}()
	}
	return v.mx.HasServiceMethod(serviceID, methodID)
}

// _ is a type assertion
var _ Mux = ((*VMux)(nil))
