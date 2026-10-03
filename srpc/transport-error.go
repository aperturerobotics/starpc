package srpc

// TransportError preserves a forwarded transport failure and its diagnostic.
// Its cause remains recognizable with errors.Is across any number of RPC hops.
type TransportError struct {
	// code is the transport failure received in the completion packet.
	code ErrorCode
	// message is the original diagnostic, without forwarding prefixes.
	message string
}

// NewTransportError constructs a failure for a schema-defined transport code.
func NewTransportError(code ErrorCode, message string) *TransportError {
	return &TransportError{code: code, message: message}
}

// Error returns the original remote diagnostic.
func (e *TransportError) Error() string {
	return e.message
}

// Unwrap returns the corresponding local transport failure.
func (e *TransportError) Unwrap() error {
	switch e.code {
	case ErrorCode_ERROR_CODE_RESET:
		return ErrReset
	case ErrorCode_ERROR_CODE_CLOSED_BEFORE_COMPLETION:
		return ErrClosedBeforeCompletion
	default:
		return nil
	}
}
