package srpc

// Message is the vtprotobuf message interface.
type Message interface {
	MarshalVT() ([]byte, error)
	UnmarshalVT([]byte) error
}

// RawMessage is a raw protobuf message container.
type RawMessage struct {
	data []byte
	copy bool
}

// NewRawMessage constructs a new raw message.
// If copy=true, copies data in MarshalVT.
// Note: the data buffer will be retained and used.
// The data buffer will be written to and/or replaced in UnmarshalVT.
func NewRawMessage(data []byte, copy bool) *RawMessage {
	return &RawMessage{data: data, copy: copy}
}

func (m *RawMessage) MarshalVT() ([]byte, error) {
	if !m.copy {
		return m.data, nil
	}

	data := make([]byte, len(m.data))
	copy(data, m.data)
	return data, nil
}

func (m *RawMessage) UnmarshalVT(data []byte) error {
	if cap(m.data) >= len(data) {
		m.data = m.data[:len(data)]
	} else {
		m.data = make([]byte, len(data))
	}
	copy(m.data, data)
	return nil
}

// _ is a type assertion
var _ Message = ((*RawMessage)(nil))
