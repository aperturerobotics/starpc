package srpc

import (
	"io"

	"github.com/libp2p/go-libp2p/core/network"
)

// MuxedStreamRwc is a ReadWriteCloser for a MuxedStream.
//
// The Close() is remapped to CloseSend().
type MuxedStreamRwc struct {
	network.MuxedStream
}

// NewMuxedStreamRwc constructs a io.ReadWriteCloser from a MuxedStream.
func NewMuxedStreamRwc(ms network.MuxedStream) *MuxedStreamRwc {
	return &MuxedStreamRwc{MuxedStream: ms}
}

// Close closes the muxed stream rwc.
func (m *MuxedStreamRwc) Close() error {
	return m.MuxedStream.CloseWrite()
}

// _ is a type assertion
var _ io.ReadWriteCloser = ((*MuxedStreamRwc)(nil))
