#pragma once

#include <string>
#include <thread>

#include "common-rpc.hpp"
#include "errors.hpp"
#include "invoker.hpp"
#include "msg-stream.hpp"
#include "writer.hpp"

namespace srpc {
class Packet;
class CallStart;
} // namespace srpc

namespace starpc {

// ServerRPC runs one handler and cancels and joins it on destruction. The
// Invoker and PacketWriter must outlive it. HandlePacket calls are serialized
// by the transport; handlers observe cancellation through Stream::StopToken.
class ServerRPC : public CommonRPC, public MsgStreamRw {
public:
  ServerRPC(Invoker *invoker, PacketWriter *writer);
  ~ServerRPC() override;

  // HandlePacketData handles an incoming unparsed message packet.
  Error HandlePacketData(const std::string &data);

  // HandlePacket handles an incoming parsed message packet.
  Error HandlePacket(const srpc::Packet &msg);

  // HandleCallStart handles the call start packet.
  Error HandleCallStart(const srpc::CallStart &pkt);

  // MsgStreamRw interface implementation
  Error ReadOne(std::string *out) override { return CommonRPC::ReadOne(out); }
  Error WriteCallData(const std::string &data, bool data_is_zero, bool complete,
                      Error err) override {
    return CommonRPC::WriteCallData(data, data_is_zero, complete, err);
  }
  Error WriteCallCancel() override { return CommonRPC::WriteCallCancel(); }
  std::string RemoteErrorMessage() const override { return CommonRPC::RemoteErrorMessage(); }

private:
  // InvokeRPC invokes the RPC after CallStart is received.
  void InvokeRPC(const std::string &service_id, const std::string &method_id);

  Invoker *invoker_;
  std::jthread invoke_thread_;
};

// NewServerRPC constructs a new ServerRPC session.
inline std::unique_ptr<ServerRPC> NewServerRPC(Invoker *invoker, PacketWriter *writer) {
  return std::make_unique<ServerRPC>(invoker, writer);
}

} // namespace starpc
