#pragma once

#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <tuple>

#include "rpcstream/read-pump.hpp"
#include "rpcstream/rpcstream.pb.h"
#include "rpcstream/writer.hpp"
#include "srpc/client.hpp"
#include "srpc/errors.hpp"
#include "srpc/invoker.hpp"
#include "srpc/packet.hpp"
#include "srpc/stream.hpp"
#include "srpc/writer.hpp"

namespace rpcstream {

// RpcStream is a bidirectional stream for RpcStreamPacket messages.
class RpcStream {
public:
  virtual ~RpcStream() = default;

  // Send sends an RpcStreamPacket to the remote.
  virtual starpc::Error Send(const RpcStreamPacket &msg) = 0;

  // Recv receives an RpcStreamPacket from the remote.
  virtual starpc::Error Recv(RpcStreamPacket *msg) = 0;

  // CloseSend signals to the remote that we will no longer send messages.
  virtual starpc::Error CloseSend() = 0;

  // Close closes the stream for reading and writing.
  virtual starpc::Error Close() = 0;
};

// RpcStreamGetter looks up an Invoker for a component ID.
// Returns (invoker, release_fn, error).
using RpcStreamGetter =
    std::function<std::tuple<starpc::Invoker *, std::function<void()>,
                             starpc::Error>(const std::string &component_id)>;

// OpenRpcStream performs the client-side init/ack handshake.
starpc::Error OpenRpcStream(RpcStream *stream, const std::string &component_id,
                            bool wait_ack);

// HandleRpcStream handles the server-side of an RpcStream connection.
starpc::Error HandleRpcStream(std::shared_ptr<RpcStream> stream,
                              RpcStreamGetter getter);

// NewRpcStreamOpenStream creates an OpenStreamFunc for use with Client.
// The RpcStreamCaller must return a pair of (shared_ptr<RpcStream>, Error).
template <typename RpcStreamCaller>
starpc::OpenStreamFunc NewRpcStreamOpenStream(RpcStreamCaller caller,
                                              const std::string &component_id,
                                              bool wait_ack) {
  return
      [caller, component_id, wait_ack](starpc::PacketDataHandler msg_handler,
                                       starpc::CloseHandler close_handler)
          -> std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error> {
        auto [stream, err] = caller();
        if (err != starpc::Error::OK) {
          return {nullptr, err};
        }

        err = OpenRpcStream(stream.get(), component_id, wait_ack);
        if (err != starpc::Error::OK) {
          stream->Close();
          return {nullptr, err};
        }

        // Create writer with shared_ptr to keep stream alive
        auto writer = std::make_unique<RpcStreamWriter>(stream);

        // Start read pump in background thread
        // The shared_ptr ensures the stream stays alive until both the writer
        // and the read pump are done with it.
        std::thread([stream, msg_handler, close_handler]() {
          ReadPump(stream, msg_handler, close_handler);
        }).detach();

        return {std::move(writer), starpc::Error::OK};
      };
}

// NewRpcStreamClient creates a Client that uses RpcStream as transport.
template <typename RpcStreamCaller>
std::unique_ptr<starpc::Client>
NewRpcStreamClient(RpcStreamCaller caller, const std::string &component_id,
                   bool wait_ack) {
  auto open_stream =
      NewRpcStreamOpenStream(std::move(caller), component_id, wait_ack);
  return starpc::NewClient(std::move(open_stream));
}

} // namespace rpcstream
