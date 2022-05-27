package srpc

// Message is the vtprotobuf message interface.
type Message interface {
	MarshalVT() ([]byte, error)
	UnmarshalVT([]byte) error
}
