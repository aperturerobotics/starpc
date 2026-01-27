# Getting Started with starpc in Go

This guide walks you through building your first starpc service in Go, covering server and client implementation with all streaming patterns.

## Prerequisites

- **Go** 1.21+
- **protoc** - Protocol Buffers compiler ([installation guide](https://grpc.io/docs/protoc-installation/))
- **Make** (optional, for code generation)

## Installation

The easiest way to get started is with the template project:

```bash
# Clone the template project
git clone -b starpc https://github.com/aperturerobotics/protobuf-project
cd protobuf-project

# Generate Go code
make gen
```

Or add starpc to an existing Go project:

```bash
go get github.com/aperturerobotics/starpc
```

## Project Setup

A typical starpc Go project structure:

```
my-project/
├── proto/
│   └── echo.proto          # Your service definitions
├── echo/
│   ├── echo.pb.go          # Generated message types
│   ├── echo_srpc.pb.go     # Generated service interfaces
│   └── server.go           # Server implementation
├── go.mod
└── Makefile
```

## Defining Proto Services

Create your service definition in a `.proto` file:

```protobuf
syntax = "proto3";
package echo;

option go_package = "github.com/myproject/echo";

// Echoer service returns the given message.
service Echoer {
  // Unary RPC - single request, single response
  rpc Echo(EchoMsg) returns (EchoMsg);

  // Server streaming - single request, stream of responses
  rpc EchoServerStream(EchoMsg) returns (stream EchoMsg);

  // Client streaming - stream of requests, single response
  rpc EchoClientStream(stream EchoMsg) returns (EchoMsg);

  // Bidirectional streaming - stream both ways
  rpc EchoBidiStream(stream EchoMsg) returns (stream EchoMsg);
}

message EchoMsg {
  string body = 1;
}
```

## Generating Code

The template project uses `protoc-gen-go-starpc` to generate Go code:

```bash
make gen
```

This generates two files per proto:
- `*.pb.go` - Message types (e.g., `EchoMsg`)
- `*_srpc.pb.go` - Service interfaces and client

Generated types include:
- `SRPCEchoerServer` - Server interface to implement
- `SRPCEchoerClient` - Client interface
- `SRPCEchoerHandler` - Handler for registration
- `SRPCRegisterEchoer()` - Helper to register with mux

## Implementing a Server

Create a struct that implements the generated server interface:

```go
package echo

import (
	"context"
	"errors"
	"io"
	"time"

	srpc "github.com/aperturerobotics/starpc/srpc"
)

// EchoServer implements the server side of Echoer.
type EchoServer struct{}

// NewEchoServer constructs a new EchoServer.
func NewEchoServer() *EchoServer {
	return &EchoServer{}
}

// Register registers the Echo server with the Mux.
func (s *EchoServer) Register(mux srpc.Mux) error {
	return SRPCRegisterEchoer(mux, s)
}

// Echo implements SRPCEchoerServer - unary RPC
func (*EchoServer) Echo(ctx context.Context, msg *EchoMsg) (*EchoMsg, error) {
	return msg.CloneVT(), nil
}

// EchoServerStream implements SRPCEchoerServer - server streaming
func (*EchoServer) EchoServerStream(msg *EchoMsg, strm SRPCEchoer_EchoServerStreamStream) error {
	// Send 5 responses with delay
	for i := 0; i < 5; i++ {
		if err := strm.MsgSend(msg); err != nil {
			return err
		}
		select {
		case <-strm.Context().Done():
			return context.Canceled
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil
}

// EchoClientStream implements SRPCEchoerServer - client streaming
func (*EchoServer) EchoClientStream(strm SRPCEchoer_EchoClientStreamStream) (*EchoMsg, error) {
	// Return the first message received
	return strm.Recv()
}

// EchoBidiStream implements SRPCEchoerServer - bidirectional streaming
func (*EchoServer) EchoBidiStream(strm SRPCEchoer_EchoBidiStreamStream) error {
	// Send initial message
	if err := strm.MsgSend(&EchoMsg{Body: "hello from server"}); err != nil {
		return err
	}
	// Echo all received messages
	for {
		msg, err := strm.Recv()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if err := strm.Send(msg); err != nil {
			return err
		}
	}
}

// Compile-time interface check
var _ SRPCEchoerServer = (*EchoServer)(nil)
```

### Setting Up the Server

```go
package main

import (
	"github.com/myproject/echo"
	srpc "github.com/aperturerobotics/starpc/srpc"
)

func main() {
	// Create the server implementation
	echoServer := echo.NewEchoServer()

	// Create the mux and register handlers
	mux := srpc.NewMux()
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		panic(err)
	}

	// Create the server
	server := srpc.NewServer(mux)

	// Use server with your transport...
}
```

## Implementing a Client

### In-Memory Connection (Testing)

```go
package main

import (
	"context"

	"github.com/myproject/echo"
	srpc "github.com/aperturerobotics/starpc/srpc"
)

func main() {
	// Create server
	echoServer := echo.NewEchoServer()
	mux := srpc.NewMux()
	_ = echo.SRPCRegisterEchoer(mux, echoServer)
	server := srpc.NewServer(mux)

	// Create an in-memory connection to the server
	openStream := srpc.NewServerPipe(server)

	// Create client
	client := srpc.NewClient(openStream)

	// Create the service client
	echoClient := echo.NewSRPCEchoerClient(client)

	// Make a unary call
	ctx := context.Background()
	result, err := echoClient.Echo(ctx, &echo.EchoMsg{Body: "Hello!"})
	if err != nil {
		panic(err)
	}
	println("result:", result.GetBody())
}
```

## Running the Example

Here's a complete example with in-memory transport:

```go
package main

import (
	"context"
	"fmt"

	"github.com/myproject/echo"
	srpc "github.com/aperturerobotics/starpc/srpc"
)

func main() {
	// Setup server
	echoServer := echo.NewEchoServer()
	mux := srpc.NewMux()
	if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
		panic(err)
	}
	server := srpc.NewServer(mux)

	// Create in-memory pipe
	openStream := srpc.NewServerPipe(server)
	client := srpc.NewClient(openStream)
	echoClient := echo.NewSRPCEchoerClient(client)

	// Test unary call
	ctx := context.Background()
	result, err := echoClient.Echo(ctx, &echo.EchoMsg{Body: "Hello!"})
	if err != nil {
		panic(err)
	}
	fmt.Println("Echo result:", result.GetBody())
}
```

## Common Patterns

### Unary RPC

```go
// Client
result, err := echoClient.Echo(ctx, &echo.EchoMsg{Body: "Hello"})
if err != nil {
	return err
}
fmt.Println(result.GetBody())

// Server
func (*EchoServer) Echo(ctx context.Context, msg *EchoMsg) (*EchoMsg, error) {
	return &EchoMsg{Body: "Echo: " + msg.GetBody()}, nil
}
```

### Server Streaming

```go
// Client - receive stream of responses
stream, err := echoClient.EchoServerStream(ctx, &echo.EchoMsg{Body: "Hello"})
if err != nil {
	return err
}
for {
	msg, err := stream.Recv()
	if err == io.EOF {
		break
	}
	if err != nil {
		return err
	}
	fmt.Println("received:", msg.GetBody())
}

// Server - send multiple responses
func (*EchoServer) EchoServerStream(msg *EchoMsg, strm SRPCEchoer_EchoServerStreamStream) error {
	for i := 0; i < 5; i++ {
		if err := strm.Send(&EchoMsg{Body: fmt.Sprintf("Response %d", i)}); err != nil {
			return err
		}
	}
	return nil
}
```

### Client Streaming

```go
// Client - send multiple messages
stream, err := echoClient.EchoClientStream(ctx)
if err != nil {
	return err
}
for _, body := range []string{"msg1", "msg2", "msg3"} {
	if err := stream.Send(&echo.EchoMsg{Body: body}); err != nil {
		return err
	}
}
response, err := stream.CloseAndRecv()
if err != nil {
	return err
}
fmt.Println("response:", response.GetBody())

// Server - receive stream, return single response
func (*EchoServer) EchoClientStream(strm SRPCEchoer_EchoClientStreamStream) (*EchoMsg, error) {
	var messages []string
	for {
		msg, err := strm.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		messages = append(messages, msg.GetBody())
	}
	return &EchoMsg{Body: strings.Join(messages, ", ")}, nil
}
```

### Bidirectional Streaming

```go
// Client - send and receive simultaneously
stream, err := echoClient.EchoBidiStream(ctx)
if err != nil {
	return err
}

// Send in goroutine
go func() {
	for _, body := range []string{"Hello", "World"} {
		stream.Send(&echo.EchoMsg{Body: body})
	}
	stream.CloseSend()
}()

// Receive
for {
	msg, err := stream.Recv()
	if err == io.EOF {
		break
	}
	if err != nil {
		return err
	}
	fmt.Println("received:", msg.GetBody())
}

// Server - echo messages
func (*EchoServer) EchoBidiStream(strm SRPCEchoer_EchoBidiStreamStream) error {
	for {
		msg, err := strm.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := strm.Send(msg); err != nil {
			return err
		}
	}
}
```

## Stream Methods

All stream types provide these methods:

| Method | Description |
|--------|-------------|
| `Context()` | Returns the stream's context |
| `MsgSend(msg)` | Send a protobuf message |
| `MsgRecv(msg)` | Receive into a protobuf message |
| `Send(msg)` | Type-safe send (generated) |
| `Recv()` | Type-safe receive (generated) |
| `CloseSend()` | Close the send side |

Server streaming adds:
- `SendAndClose(msg)` - Send final message and close

Client streaming adds:
- `CloseAndRecv()` - Close send and receive response

## Testing

Use in-memory pipes for unit tests:

```go
func TestEchoServer(t *testing.T) {
	// Setup
	mux := srpc.NewMux()
	_ = echo.SRPCRegisterEchoer(mux, echo.NewEchoServer())
	server := srpc.NewServer(mux)
	client := srpc.NewClient(srpc.NewServerPipe(server))
	echoClient := echo.NewSRPCEchoerClient(client)

	// Test
	ctx := context.Background()
	result, err := echoClient.Echo(ctx, &echo.EchoMsg{Body: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if result.GetBody() != "test" {
		t.Fatalf("expected 'test', got %q", result.GetBody())
	}
}
```

## Next Steps

- [Echo example](./echo) - Complete working example
- [Integration tests](./integration) - Go/TypeScript interop examples
- [rpcstream](./rpcstream) - Nested RPC streams
- [README](./README.md) - Full documentation
