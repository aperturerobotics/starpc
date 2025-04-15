package rpcstream

import "github.com/aperturerobotics/starpc/srpc"

// RpcStreamWriter implements the Writer only.
type RpcStreamWriter struct {
	RpcStream
}

// NewRpcStreamWriter constructs a new rpc stream writer.
func NewRpcStreamWriter(rpcStream RpcStream) *RpcStreamWriter {
	return &RpcStreamWriter{RpcStream: rpcStream}
}

// Write writes a packet to the writer.
func (r *RpcStreamWriter) Write(p []byte) (n int, err error) {
	if len(p) == 0 {
		return 0, nil
	}
	err = r.Send(&RpcStreamPacket{
		Body: &RpcStreamPacket_Data{
			Data: p,
		},
	})
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// WritePacket writes a packet to the remote.
func (r *RpcStreamWriter) WritePacket(p *srpc.Packet) error {
	pktData, err := p.MarshalVT()
	if err != nil {
		return err
	}
	_, err = r.Write(pktData)
	return err
}

// Close closes the writer.
func (r *RpcStreamWriter) Close() error {
	return r.CloseSend()
}

// _ is a type assertion
var _ srpc.PacketWriter = ((*RpcStreamWriter)(nil))
