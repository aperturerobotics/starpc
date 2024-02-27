package echo

import (
	"github.com/aperturerobotics/starpc/rpcstream"
	srpc "github.com/aperturerobotics/starpc/srpc"
)

// _ is a type assertion
var (
	_ srpc.StreamRecv[*EchoMsg] = (SRPCEchoer_EchoBidiStreamClient)(nil)
	_ srpc.StreamRecv[*EchoMsg] = (SRPCEchoer_EchoServerStreamClient)(nil)

	_ srpc.StreamSend[*EchoMsg] = (SRPCEchoer_EchoBidiStreamClient)(nil)
	_ srpc.StreamSend[*EchoMsg] = (SRPCEchoer_EchoClientStreamClient)(nil)

	_ srpc.StreamSendAndClose[*EchoMsg] = (SRPCEchoer_EchoBidiStreamStream)(nil)
	_ srpc.StreamSendAndClose[*EchoMsg] = (SRPCEchoer_EchoServerStreamStream)(nil)

	_ srpc.StreamRecv[*rpcstream.RpcStreamPacket]         = (SRPCEchoer_RpcStreamStream)(nil)
	_ srpc.StreamSendAndClose[*rpcstream.RpcStreamPacket] = (SRPCEchoer_RpcStreamStream)(nil)
)
