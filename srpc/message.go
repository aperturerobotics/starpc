package srpc

import (
	"errors"

	protobuf_go_lite "github.com/aperturerobotics/protobuf-go-lite"
)

// Message is the vtprotobuf message interface.
type Message = protobuf_go_lite.Message

// SizedMessage is the encoding half of a Message: it reports its encoded size
// and marshals into a buffer of that size, so a writer can encode it directly
// into the buffer it sends.
type SizedMessage interface {
	// SizeVT returns the size of the message when marshaled.
	SizeVT() int
	// MarshalToSizedBufferVT marshals to the end of a buffer that is at least
	// SizeVT bytes long, and returns the number of bytes written.
	MarshalToSizedBufferVT(dAtA []byte) (int, error)
}

// RawMessage is a raw protobuf message container.
//
// The empty value is valid with copy=false.
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

// GetData returns the data buffer without copying.
func (m *RawMessage) GetData() []byte {
	return m.data
}

// SetData sets the data buffer.
// if copy=true, copies the data to the internal slice.
// otherwise retains the buffer.
func (m *RawMessage) SetData(data []byte) {
	if m.copy {
		if cap(m.data) >= len(data) {
			m.data = m.data[:len(data)]
		} else {
			m.data = make([]byte, len(data))
		}
		copy(m.data, data)
	} else {
		m.data = data
	}
}

// Clear sets the length of the data buffer to 0 without releasing it.
func (m *RawMessage) Clear() {
	m.data = m.data[:0]
}

// Reset releases the data buffer.
func (m *RawMessage) Reset() {
	m.data = nil
}

// MarshalVT returns the data, or a copy of it when the message copies.
func (m *RawMessage) MarshalVT() ([]byte, error) {
	if !m.copy {
		return m.data, nil
	}

	data := make([]byte, len(m.data))
	copy(data, m.data)
	return data, nil
}

// UnmarshalVT sets the data to the given bytes.
func (m *RawMessage) UnmarshalVT(data []byte) error {
	m.SetData(data)
	return nil
}

// SizeVT returns the size of the message when marshaled.
func (m *RawMessage) SizeVT() int {
	return len(m.data)
}

// MarshalToSizedBufferVT marshals to a buffer that already is SizeVT bytes long.
func (m *RawMessage) MarshalToSizedBufferVT(dAtA []byte) (int, error) {
	if len(dAtA) != len(m.data) {
		return 0, errors.New("invalid buffer length")
	}
	copy(dAtA, m.data)
	return len(dAtA), nil
}

// _ is a type assertion
var _ Message = (*RawMessage)(nil)
