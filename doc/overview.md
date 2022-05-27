# Overview

For a service:

```protobuf
syntax = "proto3";
package web.demo;

service DemoService {
  rpc DemoEcho(DemoEchoMsg) returns (DemoEchoMsg) {}
}

message DemoEchoMsg {
  string msg = 1;
}
```

ts-proto generates a RPC interface like:

```typescript
export interface DemoService {
  DemoEcho(request: DemoEchoMsg): Promise<DemoEchoMsg>
}

export class DemoServiceClientImpl implements DemoService {
  private readonly rpc: Rpc
  constructor(rpc: Rpc) {
    this.rpc = rpc
    this.DemoEcho = this.DemoEcho.bind(this)
  }
  DemoEcho(request: DemoEchoMsg): Promise<DemoEchoMsg> {
    const data = DemoEchoMsg.encode(request).finish()
    const promise = this.rpc.request('web.demo.DemoService', 'DemoEcho', data)
    return promise.then((data) => DemoEchoMsg.decode(new _m0.Reader(data)))
  }
}
```

Where the RPC interface is:

```typescript
interface Rpc {
  request(
    service: string,
    method: string,
    data: Uint8Array
  ): Promise<Uint8Array>
  clientStreamingRequest(
    service: string,
    method: string,
    data: Observable<Uint8Array>
  ): Promise<Uint8Array>
  serverStreamingRequest(
    service: string,
    method: string,
    data: Uint8Array
  ): Observable<Uint8Array>
  bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: Observable<Uint8Array>
  ): Observable<Uint8Array>
}
```

This package (ts-drpc) implements the Rpc interface.
