#pragma once

#include "rpcstream/read-pump.hpp"
#include "rpcstream/rpcstream.pb.h"
#include "rpcstream/writer.hpp"
#include "srpc/client.hpp"
#include "srpc/invoker.hpp"

#include <functional>
#include <memory>
#include <string>
#include <tuple>

namespace rpcstream {

// RpcStream carries nested RPC packets. Close interrupts Send and Recv and is
// safe to call concurrently and repeatedly; CloseSend only ends outgoing data.
class RpcStream {
public:
  virtual ~RpcStream() = default;
  virtual starpc::Error Send(const RpcStreamPacket &msg) = 0;
  virtual starpc::Error Recv(RpcStreamPacket *msg) = 0;
  virtual starpc::Error CloseSend() = 0;
  virtual starpc::Error Close() = 0;
};

// RpcStreamGetter lends an Invoker until the returned release function runs.
using RpcStreamGetter =
    std::function<std::tuple<starpc::Invoker *, std::function<void()>, starpc::Error>(
        const std::string &component_id)>;

// OpenRpcStream performs the client-side init/ack handshake.
starpc::Error OpenRpcStream(RpcStream *stream, const std::string &component_id, bool wait_ack);

// HandleRpcStream joins the nested handler before releasing its Invoker.
starpc::Error HandleRpcStream(std::shared_ptr<RpcStream> stream, RpcStreamGetter getter);

// StartReadPump returns a writer that interrupts and joins its receive thread on
// destruction. The stream is shared by its caller and that receive thread.
std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error>
StartReadPump(std::shared_ptr<RpcStream> stream, starpc::PacketDataHandler handler,
              starpc::CloseHandler closed);

// NewRpcStreamOpenStream adapts a stream factory to the client transport boundary.
template <typename RpcStreamCaller>
starpc::OpenStreamFunc NewRpcStreamOpenStream(RpcStreamCaller caller,
                                              const std::string &component_id, bool wait_ack) {
  return [caller, component_id, wait_ack](starpc::PacketDataHandler handler,
                                          starpc::CloseHandler closed)
             -> std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error> {
    auto [stream, err] = caller();
    if (err != starpc::Error::OK)
      return {nullptr, err};
    err = OpenRpcStream(stream.get(), component_id, wait_ack);
    if (err != starpc::Error::OK) {
      stream->Close();
      return {nullptr, err};
    }
    return StartReadPump(std::move(stream), std::move(handler), std::move(closed));
  };
}

// NewRpcStreamClient creates a client whose transport uses nested RPC streams.
template <typename RpcStreamCaller>
std::unique_ptr<starpc::Client> NewRpcStreamClient(RpcStreamCaller caller,
                                                   const std::string &component_id, bool wait_ack) {
  return starpc::NewClient(NewRpcStreamOpenStream(std::move(caller), component_id, wait_ack));
}

} // namespace rpcstream
