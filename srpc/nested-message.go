package srpc

import (
	"errors"

	protobuf_go_lite "github.com/aperturerobotics/protobuf-go-lite"
)

// wireTypeBytes is the protobuf wire type of a length-delimited field.
const wireTypeBytes = 2

const (
	// packetCallDataField is the field number of Packet.call_data.
	packetCallDataField = 2
	// callDataDataField is the field number of CallData.data.
	callDataDataField = 1
)

// errNestedWriteOnly is returned when a NestedMessage is asked to decode.
var errNestedWriteOnly = errors.New("nested message is write-only")

// errNestedBufferSize is returned when the output buffer is smaller than the encoding.
var errNestedBufferSize = errors.New("invalid buffer length")

// NestedMessage is a write-only message encoded as one length-delimited
// field that carries another message: the wire form of a message whose only
// set field is a bytes or message field holding the inner encoding.
//
// A frame that wraps frames, such as an SRPC packet around a call data around
// a response, nests one NestedMessage per layer. SizeVT sums the layers and
// MarshalToSizedBufferVT encodes the innermost message directly into the final
// buffer, so no layer holds its own copy of the bytes it wraps.
//
// The inner message must not change between construction and encoding.
type NestedMessage struct {
	// field is the field number of the length-delimited field.
	field uint32
	// inner is the message carried by the field.
	inner SizedMessage
	// innerSize is inner.SizeVT(), computed once at construction.
	innerSize int
}

// NewNestedMessage wraps inner as field number field of an enclosing message.
//
// The field is always written, even when inner encodes to zero bytes, as a
// message or oneof field is.
func NewNestedMessage(field uint32, inner SizedMessage) *NestedMessage {
	return &NestedMessage{field: field, inner: inner, innerSize: inner.SizeVT()}
}

// SizeVT returns the size of the message when marshaled.
func (m *NestedMessage) SizeVT() int {
	return nestedHeaderSize(m.field, m.innerSize) + m.innerSize
}

// MarshalToSizedBufferVT marshals to the end of dAtA, which must be at least
// SizeVT bytes long, and returns the number of bytes written.
func (m *NestedMessage) MarshalToSizedBufferVT(dAtA []byte) (int, error) {
	// Encode the inner message in place at the end of the buffer.
	i := len(dAtA)
	if i < m.SizeVT() {
		return 0, errNestedBufferSize
	}
	written, err := m.inner.MarshalToSizedBufferVT(dAtA[i-m.innerSize : i])
	if err != nil {
		return 0, err
	}
	if written != m.innerSize {
		return 0, errNestedBufferSize
	}
	i -= written

	// Prefix the field length and key.
	i = protobuf_go_lite.EncodeVarint(dAtA, i, uint64(m.innerSize)) //nolint:gosec
	i = protobuf_go_lite.EncodeVarint(dAtA, i, uint64(m.field)<<3|wireTypeBytes)
	return len(dAtA) - i, nil
}

// MarshalVT marshals the message into a new buffer.
func (m *NestedMessage) MarshalVT() ([]byte, error) {
	dAtA := make([]byte, m.SizeVT())
	n, err := m.MarshalToSizedBufferVT(dAtA)
	if err != nil {
		return nil, err
	}
	return dAtA[:n], nil
}

// UnmarshalVT returns an error: a NestedMessage only encodes.
func (m *NestedMessage) UnmarshalVT([]byte) error {
	return errNestedWriteOnly
}

// Reset does nothing: a NestedMessage holds no decoded state.
func (m *NestedMessage) Reset() {}

// nestedHeaderSize returns the size of the key and length prefix of a field.
func nestedHeaderSize(field uint32, innerSize int) int {
	key := uint64(field)<<3 | wireTypeBytes
	return protobuf_go_lite.SizeOfVarint(key) + protobuf_go_lite.SizeOfVarint(uint64(innerSize)) //nolint:gosec
}

// _ is a type assertion
var _ Message = (*NestedMessage)(nil)
