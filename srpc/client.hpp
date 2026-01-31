#pragma once

#include <functional>
#include <memory>
#include <string>
#include <utility>

#include "client-rpc.hpp"
#include "errors.hpp"
#include "message.hpp"
#include "msg-stream.hpp"
#include "packet.hpp"
#include "stream.hpp"
#include "writer.hpp"

namespace starpc {

// OpenStreamFunc opens a stream with a remote.
// msgHandler must not be called concurrently.
// Matches Go OpenStreamFunc in client.go
using OpenStreamFunc = std::function<std::pair<std::unique_ptr<PacketWriter>, Error>(
    PacketDataHandler msg_handler,
    CloseHandler close_handler)>;

// Client implements a SRPC client which can initiate RPC streams.
// Matches Go Client interface in client.go
class Client {
 public:
  virtual ~Client() = default;

  // ExecCall executes a request/reply RPC with the remote.
  virtual Error ExecCall(
      const std::string& service,
      const std::string& method,
      const Message& in,
      Message* out) = 0;

  // NewStream starts a streaming RPC with the remote & returns the stream.
  // firstMsg is optional (can be nullptr).
  virtual std::pair<std::unique_ptr<Stream>, Error> NewStream(
      const std::string& service,
      const std::string& method,
      const Message* first_msg) = 0;
};

// ClientImpl is the default implementation of Client with a transport.
// Matches Go client struct in client.go
class ClientImpl : public Client {
 public:
  explicit ClientImpl(OpenStreamFunc open_stream)
      : open_stream_(std::move(open_stream)) {}

  Error ExecCall(
      const std::string& service,
      const std::string& method,
      const Message& in,
      Message* out) override;

  std::pair<std::unique_ptr<Stream>, Error> NewStream(
      const std::string& service,
      const std::string& method,
      const Message* first_msg) override;

 private:
  OpenStreamFunc open_stream_;
};

// NewClient constructs a client with a OpenStreamFunc.
// Matches Go NewClient function in client.go
inline std::unique_ptr<Client> NewClient(OpenStreamFunc open_stream) {
  return std::make_unique<ClientImpl>(std::move(open_stream));
}

}  // namespace starpc
