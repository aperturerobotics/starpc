# Overview

For a service:

```protobuf
syntax = "proto3";
package simple;

service DemoService {
  rpc BidiStreaming(stream TestMessage) returns (stream TestMessage) {}
}

message TestMessage {
  string value = 1;
}
```

ts-proto generates a RPC interface like:

```typescript
export interface DemoService {
  BidiStreaming(request: AsyncIterable<TestMessage>): AsyncIterable<TestMsg>
}

export class DemoServiceClient implements DemoService {
  private readonly rpc: Rpc
  constructor(rpc: Rpc) {
    this.rpc = rpc
    this.BidiStreaming = this.BidiStreaming.bind(this)
  }
  BidiStreaming(request: AsyncIterable<TestMessage>): AsyncIterable<TestMessage> {
    const data = TestMessage.encodeTransform(request);
    const result = this.rpc.bidirectionalStreamingRequest('simple.Test', 'BidiStreaming', data);
    return TestMessage.decodeTransform(result);
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
    data: AsyncIterable<Uint8Array>
  ): Promise<Uint8Array>
  serverStreamingRequest(
    service: string,
    method: string,
    data: Uint8Array
  ): AsyncIterable<Uint8Array>
  bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: AsyncIterable<Uint8Array>
  ): AsyncIterable<Uint8Array>
}
```

This package (ts-drpc) implements the Rpc interface.
