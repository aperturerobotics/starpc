# Getting Started with starpc in C++

This guide walks you through building your first starpc service in C++, covering server and client implementation with all streaming patterns.

## Prerequisites

- **C++17** compatible compiler (GCC 8+, Clang 7+, MSVC 2019+)
- **CMake** 3.16+
- **Go** 1.21+ (for code generation)

No separate protoc installation is required - the code generator uses an embedded WebAssembly version of protoc via [go-protoc-wasi].

## Installation

The easiest way to get started is with the template project:

```bash
# Clone the template project
git clone -b starpc https://github.com/aperturerobotics/protobuf-project
cd protobuf-project

# Install dependencies
bun install

# Generate C++ code
bun run gen
```

Or add starpc to an existing C++ project by vendoring the dependencies:

```bash
# Add as Go module dependencies (for code generation)
go get github.com/aperturerobotics/starpc
go get github.com/aperturerobotics/common

# Vendor dependencies
go mod vendor
```

## Project Setup

A typical starpc C++ project structure:

```
my-project/
├── echo/
│   ├── echo.proto              # Your service definitions
│   ├── echo.pb.h               # Generated message types
│   ├── echo.pb.cc              # Generated message implementation
│   ├── echo_srpc.pb.hpp        # Generated service interfaces
│   ├── echo_srpc.pb.cpp        # Generated service implementation
│   └── server.cpp              # Server implementation
├── vendor/
│   └── github.com/aperturerobotics/
│       ├── starpc/srpc/        # starpc library headers
│       ├── protobuf/           # Vendored protobuf library
│       └── abseil-cpp/         # Vendored Abseil library
├── CMakeLists.txt
└── go.mod
```

## Defining Proto Services

Create your service definition in a `.proto` file:

```protobuf
syntax = "proto3";
package echo;

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

The template project uses `protoc-gen-starpc-cpp` to generate C++ code:

```bash
bun run gen
```

This generates four files per proto:
- `*.pb.h` - Message type declarations (e.g., `EchoMsg`)
- `*.pb.cc` - Message type implementations
- `*_srpc.pb.hpp` - Service interfaces and client
- `*_srpc.pb.cpp` - Service implementations

Generated types include:
- `SRPCEchoerServer` - Server interface to implement
- `SRPCEchoerClient` - Client interface
- `SRPCEchoerHandler` - Handler for registration
- `SRPCRegisterEchoer()` - Helper to register with mux

## CMake Configuration

Create a `CMakeLists.txt` for your project:

```cmake
cmake_minimum_required(VERSION 3.16)
project(my_project VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find Threads
find_package(Threads REQUIRED)

# Set variables for vendored dependencies
set(VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/github.com/aperturerobotics)
set(ABSEIL_DIR ${VENDOR_DIR}/abseil-cpp)
set(PROTOBUF_DIR ${VENDOR_DIR}/protobuf)
set(STARPC_DIR ${VENDOR_DIR}/starpc)

# Configure abseil options
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(${ABSEIL_DIR} ${CMAKE_BINARY_DIR}/abseil-cpp EXCLUDE_FROM_ALL)

# Configure protobuf options
set(protobuf_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_PROTOC_BINARIES OFF CACHE BOOL "" FORCE)
set(protobuf_INSTALL OFF CACHE BOOL "" FORCE)
set(protobuf_ABSL_PROVIDER "package" CACHE STRING "" FORCE)
add_subdirectory(${PROTOBUF_DIR} ${CMAKE_BINARY_DIR}/protobuf EXCLUDE_FROM_ALL)

# Include paths
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    ${PROTOBUF_DIR}/src
    ${ABSEIL_DIR}
)

# Build starpc library
set(STARPC_SOURCES
    ${STARPC_DIR}/srpc/packet.cpp
    ${STARPC_DIR}/srpc/common-rpc.cpp
    ${STARPC_DIR}/srpc/client-rpc.cpp
    ${STARPC_DIR}/srpc/server-rpc.cpp
    ${STARPC_DIR}/srpc/mux.cpp
    ${STARPC_DIR}/srpc/client.cpp
    ${STARPC_DIR}/srpc/rpcproto.pb.cc
)

add_library(starpc ${STARPC_SOURCES})
target_link_libraries(starpc PUBLIC libprotobuf Threads::Threads)

# Your application
add_executable(my_app
    main.cpp
    echo/echo.pb.cc
    echo/echo_srpc.pb.cpp
)
target_link_libraries(my_app PRIVATE starpc)
```

## Implementing a Server

Create a class that implements the generated server interface:

```cpp
#include "echo/echo_srpc.pb.hpp"
#include "srpc/starpc.hpp"

// EchoServerImpl implements the server side of Echoer.
class EchoServerImpl : public echo::SRPCEchoerServer {
 public:
  // Echo implements SRPCEchoerServer - unary RPC
  starpc::Error Echo(const echo::EchoMsg& req, echo::EchoMsg* resp) override {
    resp->set_body(req.body());
    return starpc::Error::OK;
  }

  // EchoServerStream implements SRPCEchoerServer - server streaming
  starpc::Error EchoServerStream(const echo::EchoMsg& req,
                                  echo::SRPCEchoer_EchoServerStreamStream* strm) override {
    // Send 5 responses
    for (int i = 0; i < 5; i++) {
      echo::EchoMsg msg;
      msg.set_body(req.body());
      starpc::Error err = strm->Send(msg);
      if (err != starpc::Error::OK) {
        return err;
      }
    }
    return starpc::Error::OK;
  }

  // EchoClientStream implements SRPCEchoerServer - client streaming
  starpc::Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream* strm,
                                  echo::EchoMsg* resp) override {
    // Return the first message received
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err != starpc::Error::OK) {
      return err;
    }
    resp->set_body(msg.body());
    return starpc::Error::OK;
  }

  // EchoBidiStream implements SRPCEchoerServer - bidirectional streaming
  starpc::Error EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream* strm) override {
    // Echo all received messages
    while (true) {
      echo::EchoMsg msg;
      starpc::Error err = strm->Recv(&msg);
      if (err == starpc::Error::EOF_) {
        break;
      }
      if (err != starpc::Error::OK) {
        return err;
      }
      err = strm->Send(msg);
      if (err != starpc::Error::OK) {
        return err;
      }
    }
    return starpc::Error::OK;
  }
};
```

### Setting Up the Server

```cpp
#include "echo/echo_srpc.pb.hpp"
#include "srpc/starpc.hpp"

int main() {
  // Create the server implementation
  EchoServerImpl server_impl;

  // Create the mux and register handlers
  auto mux = starpc::NewMux();
  auto [handler, err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (err != starpc::Error::OK) {
    std::cerr << "Registration failed: " << starpc::ErrorString(err) << std::endl;
    return 1;
  }

  // Use mux with your transport...
  // The handler must outlive the mux registration
}
```

## Implementing a Client

### In-Memory Connection (Testing)

```cpp
#include <memory>
#include <mutex>
#include <queue>
#include <thread>

#include "echo/echo_srpc.pb.hpp"
#include "srpc/starpc.hpp"

// Simple in-memory transport for testing
class InMemoryTransport {
 public:
  struct Endpoint {
    std::mutex mtx;
    std::condition_variable cv;
    std::queue<std::string> packets;
    bool closed = false;
  };

  std::shared_ptr<Endpoint> client_to_server = std::make_shared<Endpoint>();
  std::shared_ptr<Endpoint> server_to_client = std::make_shared<Endpoint>();
};

// PacketWriter implementation for in-memory transport
class InMemoryPacketWriter : public starpc::PacketWriter {
 public:
  explicit InMemoryPacketWriter(std::shared_ptr<InMemoryTransport::Endpoint> ep)
      : endpoint_(ep) {}

  starpc::Error WritePacket(const srpc::Packet& pkt) override {
    std::string data;
    if (!pkt.SerializeToString(&data)) {
      return starpc::Error::InvalidMessage;
    }
    std::lock_guard<std::mutex> lock(endpoint_->mtx);
    endpoint_->packets.push(data);
    endpoint_->cv.notify_all();
    return starpc::Error::OK;
  }

  starpc::Error Close() override {
    std::lock_guard<std::mutex> lock(endpoint_->mtx);
    endpoint_->closed = true;
    endpoint_->cv.notify_all();
    return starpc::Error::OK;
  }

 private:
  std::shared_ptr<InMemoryTransport::Endpoint> endpoint_;
};
```

## Running the Example

Here's a complete example with in-memory transport:

```cpp
#include <iostream>
#include <thread>

#include "echo/echo_srpc.pb.hpp"
#include "srpc/starpc.hpp"

int main() {
  InMemoryTransport transport;

  // Setup server
  EchoServerImpl server_impl;
  auto mux = starpc::NewMux();
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "Registration error" << std::endl;
    return 1;
  }

  // Start server thread
  std::thread server_thread([&]() {
    auto writer = std::make_unique<InMemoryPacketWriter>(transport.server_to_client);
    auto server_rpc = starpc::NewServerRPC(mux.get(), writer.get());

    while (true) {
      std::string data;
      // Read from client_to_server endpoint...
      starpc::Error err = server_rpc->HandlePacketData(data);
      if (err != starpc::Error::OK && err != starpc::Error::Completed) {
        break;
      }
    }
  });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "Echo");
  auto writer = std::make_unique<InMemoryPacketWriter>(transport.client_to_server);

  // Start client receive thread
  std::thread client_recv_thread([&]() {
    // Read from server_to_client endpoint and call HandlePacketData...
  });

  // Send request
  echo::EchoMsg req;
  req.set_body("Hello!");
  std::string req_data;
  req.SerializeToString(&req_data);

  starpc::Error err = client_rpc->Start(writer.get(), true, req_data);
  if (err != starpc::Error::OK) {
    std::cerr << "Start error" << std::endl;
    return 1;
  }

  // Read response
  std::string resp_data;
  err = client_rpc->ReadOne(&resp_data);
  if (err != starpc::Error::OK) {
    std::cerr << "ReadOne error" << std::endl;
    return 1;
  }

  echo::EchoMsg resp;
  resp.ParseFromString(resp_data);
  std::cout << "Echo result: " << resp.body() << std::endl;

  // Cleanup
  client_rpc->Close();
  // ... join threads and cleanup

  return 0;
}
```

## Common Patterns

### Unary RPC

```cpp
// Client
echo::EchoMsg req, resp;
req.set_body("Hello");
starpc::Error err = echoer_client->Echo(req, &resp);
if (err != starpc::Error::OK) {
  // Handle error
}
std::cout << resp.body() << std::endl;

// Server
starpc::Error EchoServerImpl::Echo(const echo::EchoMsg& req, echo::EchoMsg* resp) {
  resp->set_body("Echo: " + req.body());
  return starpc::Error::OK;
}
```

### Server Streaming

```cpp
// Client - receive stream of responses
auto [stream, err] = echoer_client->EchoServerStream(req);
if (err != starpc::Error::OK) {
  // Handle error
}
while (true) {
  echo::EchoMsg msg;
  starpc::Error recv_err = stream->Recv(&msg);
  if (recv_err == starpc::Error::EOF_) {
    break;
  }
  if (recv_err != starpc::Error::OK) {
    // Handle error
  }
  std::cout << "received: " << msg.body() << std::endl;
}

// Server - send multiple responses
starpc::Error EchoServerImpl::EchoServerStream(
    const echo::EchoMsg& req,
    echo::SRPCEchoer_EchoServerStreamStream* strm) {
  for (int i = 0; i < 5; i++) {
    echo::EchoMsg msg;
    msg.set_body("Response " + std::to_string(i));
    starpc::Error err = strm->Send(msg);
    if (err != starpc::Error::OK) {
      return err;
    }
  }
  return starpc::Error::OK;
}
```

### Client Streaming

```cpp
// Client - send multiple messages
auto [stream, err] = echoer_client->EchoClientStream();
if (err != starpc::Error::OK) {
  // Handle error
}
for (const auto& body : {"msg1", "msg2", "msg3"}) {
  echo::EchoMsg msg;
  msg.set_body(body);
  starpc::Error send_err = stream->Send(msg);
  if (send_err != starpc::Error::OK) {
    // Handle error
  }
}
echo::EchoMsg response;
starpc::Error close_err = stream->CloseAndRecv(&response);
if (close_err != starpc::Error::OK) {
  // Handle error
}
std::cout << "response: " << response.body() << std::endl;

// Server - receive stream, return single response
starpc::Error EchoServerImpl::EchoClientStream(
    echo::SRPCEchoer_EchoClientStreamStream* strm,
    echo::EchoMsg* resp) {
  std::vector<std::string> messages;
  while (true) {
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err == starpc::Error::EOF_) {
      break;
    }
    if (err != starpc::Error::OK) {
      return err;
    }
    messages.push_back(msg.body());
  }
  // Join messages with ", "
  std::string result;
  for (size_t i = 0; i < messages.size(); i++) {
    if (i > 0) result += ", ";
    result += messages[i];
  }
  resp->set_body(result);
  return starpc::Error::OK;
}
```

### Bidirectional Streaming

```cpp
// Client - send and receive simultaneously
auto [stream, err] = echoer_client->EchoBidiStream();
if (err != starpc::Error::OK) {
  // Handle error
}

// Send in separate thread
std::thread send_thread([&stream]() {
  for (const auto& body : {"Hello", "World"}) {
    echo::EchoMsg msg;
    msg.set_body(body);
    stream->Send(msg);
  }
  stream->CloseSend();
});

// Receive
while (true) {
  echo::EchoMsg msg;
  starpc::Error recv_err = stream->Recv(&msg);
  if (recv_err == starpc::Error::EOF_) {
    break;
  }
  if (recv_err != starpc::Error::OK) {
    // Handle error
  }
  std::cout << "received: " << msg.body() << std::endl;
}
send_thread.join();

// Server - echo messages
starpc::Error EchoServerImpl::EchoBidiStream(
    echo::SRPCEchoer_EchoBidiStreamStream* strm) {
  while (true) {
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err == starpc::Error::EOF_) {
      return starpc::Error::OK;
    }
    if (err != starpc::Error::OK) {
      return err;
    }
    err = strm->Send(msg);
    if (err != starpc::Error::OK) {
      return err;
    }
  }
}
```

## Stream Methods

All stream types provide these methods:

| Method | Description |
|--------|-------------|
| `MsgSend(msg)` | Send a protobuf message |
| `MsgRecv(msg)` | Receive into a protobuf message |
| `Send(msg)` | Type-safe send (generated) |
| `Recv(msg*)` | Type-safe receive (generated) |
| `CloseSend()` | Close the send side |
| `Close()` | Close the stream |

Server streaming adds:
- `SendAndClose(msg)` - Send final message and close

Client streaming adds:
- `CloseAndRecv(msg*)` - Close send and receive response

## Error Handling

starpc uses the `starpc::Error` enum for error handling:

```cpp
enum class Error {
  OK,              // No error
  EOF_,            // End of stream
  Completed,       // RPC completed
  InvalidMessage,  // Message serialization failed
  StreamClosed,    // Stream was closed
  Unimplemented,   // Method not implemented
  // ... other errors
};

// Convert error to string
const char* ErrorString(Error err);
```

Example error handling:

```cpp
starpc::Error err = strm->Recv(&msg);
if (err == starpc::Error::EOF_) {
  // Stream ended normally
} else if (err != starpc::Error::OK) {
  std::cerr << "Error: " << starpc::ErrorString(err) << std::endl;
}
```

## Testing

Use in-memory transport for unit tests:

```cpp
#include <cassert>
#include "echo/echo_srpc.pb.hpp"
#include "srpc/starpc.hpp"

void TestEchoServer() {
  // Setup
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  assert(err == starpc::Error::OK);

  // Create in-memory transport and run test
  InMemoryTransport transport;
  // ... setup client/server threads

  echo::EchoMsg req, resp;
  req.set_body("test");

  // ... make RPC call

  assert(resp.body() == "test");
}
```

## Building

```bash
# Create build directory
mkdir build && cd build

# Configure with CMake
cmake ..

# Build
cmake --build .

# Run tests
ctest
```

## Next Steps

- [Echo example](./echo) - Complete working example
- [Integration tests](./integration) - Go/TypeScript/C++ interop examples
- [rpcstream](./rpcstream) - Nested RPC streams
- [README](./README.md) - Full documentation
- [common](https://github.com/aperturerobotics/common) - CMake integration helpers

[go-protoc-wasi]: https://github.com/aperturerobotics/go-protoc-wasi
