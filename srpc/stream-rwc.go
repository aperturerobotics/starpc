package srpc

import (
	"bytes"
	"io"
)

// StreamRwc implements an io.ReadWriteCloser with a srpc.Stream.
type StreamRwc struct {
	// Stream is the base stream interface.
	Stream

	// buf is the incoming data buffer
	buf bytes.Buffer
	// readMsg is the raw read message
	readMsg RawMessage
	// writeMsg is the raw write message
	writeMsg RawMessage
}

// NewStreamRwc constructs a new stream read write closer.
func NewStreamRwc(strm Stream) *StreamRwc {
	rwc := &StreamRwc{Stream: strm}
	rwc.readMsg.copy = true
	rwc.writeMsg.copy = true
	return rwc
}

// Read reads data from the stream to p.
// Implements io.Reader.
func (s *StreamRwc) Read(p []byte) (n int, err error) {
	readBuf := p
	for len(readBuf) != 0 && err == nil {
		var rn int

		// if the buffer has data, read from it.
		if s.buf.Len() != 0 {
			rn, err = s.buf.Read(readBuf)
		} else {
			if n != 0 {
				// if we read data to p already, return now.
				break
			}

			s.readMsg.Clear()
			if err := s.MsgRecv(&s.readMsg); err != nil {
				return n, err
			}
			data := s.readMsg.GetData()
			if len(data) == 0 {
				continue
			}

			// read as much as possible directly to the output
			copy(readBuf, data)
			if len(data) > len(readBuf) {
				// we read some of the data, buffer the rest.
				rn = len(readBuf)
				_, _ = s.buf.Write(data[rn:]) // never returns an error
			} else {
				// we read all of data
				rn = len(data)
			}
		}

		// advance readBuf by rn
		n += rn
		readBuf = readBuf[rn:]
	}
	return n, err
}

// Write writes data to the stream.
func (s *StreamRwc) Write(p []byte) (n int, err error) {
	s.writeMsg.SetData(p)
	err = s.MsgSend(&s.writeMsg)
	s.writeMsg.Clear()
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// _ is a type assertion
var _ io.ReadWriteCloser = ((*StreamRwc)(nil))
