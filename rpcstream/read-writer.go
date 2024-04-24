package rpcstream

import (
	"bytes"
	"errors"
	"io"

	"github.com/aperturerobotics/starpc/srpc"
)

// RpcStreamReadWriter reads and writes a buffered RpcStream.
type RpcStreamReadWriter struct {
	// stream is the RpcStream
	stream RpcStream
	// buf is the incoming data buffer
	buf bytes.Buffer
}

// NewRpcStreamReadWriter constructs a new read/writer.
func NewRpcStreamReadWriter(stream RpcStream) *RpcStreamReadWriter {
	return &RpcStreamReadWriter{stream: stream}
}

// ReadPump executes the read pump in a goroutine.
//
// calls the handler when closed or returning an error
func ReadPump(strm RpcStream, cb srpc.PacketDataHandler, closed srpc.CloseHandler) {
	err := ReadToHandler(strm, cb)
	// signal that the stream is now closed.
	if closed != nil {
		closed(err)
	}
}

// ReadToHandler reads data to the given handler.
// Does not handle closing the stream, use ReadPump instead.
func ReadToHandler(strm RpcStream, cb srpc.PacketDataHandler) error {
	for {
		// read packet
		pkt, err := strm.Recv()
		if err != nil {
			return err
		}

		data := pkt.GetData()
		if len(data) == 0 {
			continue
		}

		// call handler
		if err := cb(data); err != nil {
			return err
		}
	}
}

// Write writes a packet to the writer.
func (r *RpcStreamReadWriter) Write(p []byte) (n int, err error) {
	if len(p) == 0 {
		return 0, nil
	}
	err = r.stream.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Data{
			Data: p,
		},
	})
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// Read reads a packet from the writer.
func (r *RpcStreamReadWriter) Read(p []byte) (n int, err error) {
	readBuf := p
	for len(readBuf) != 0 && err == nil {
		var rn int

		// if the buffer has data, read from it.
		if r.buf.Len() != 0 {
			rn, err = r.buf.Read(readBuf)
		} else {
			if n != 0 {
				// if we read data to p already, return now.
				break
			}

			var pkt *RpcStreamPacket
			pkt, err = r.stream.Recv()
			if err != nil {
				break
			}

			if errStr := pkt.GetAck().GetError(); errStr != "" {
				return n, errors.New(errStr)
			}

			data := pkt.GetData()
			if len(data) == 0 {
				continue
			}

			// read as much as possible directly to the output
			rn = copy(readBuf, data)
			if rn < len(data) {
				// we read some of the data, buffer the rest.
				_, _ = r.buf.Write(data[rn:]) // never returns an error
			}
		}

		// advance readBuf by rn
		n += rn
		readBuf = readBuf[rn:]
	}
	return n, err
}

// Close closes the packet rw.
func (r *RpcStreamReadWriter) Close() error {
	return r.stream.Close()
}

// _ is a type assertion
var _ io.ReadWriteCloser = (*RpcStreamReadWriter)(nil)
