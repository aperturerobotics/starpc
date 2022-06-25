# RPC Stream

This package implements running a RPC service on top of another.

The "host" service has a signature like:

```protobuf
syntax = "proto3";
package mypackage;

import "github.com/aperturerobotics/starpc/rpcstream/rpcstream.proto";

// HostService proxies RPC calls to a target Mux.
service HostService {
  // MyRpc opens a stream to proxy a RPC call.
  rpc MyRpc(stream .rpcstream.RpcStreamPacket) returns (stream .rpcstream.RpcStreamPacket);
}
```

`NewRpcStreamOpenStream(componentID, hostService.MyRpc)` will construct a new
`OpenStreamFunc` which starts a RPC call to `MyRpc` and forwards the starpc
packets over the two-way stream.

The component ID can be used to determine which Mux the client should access.

