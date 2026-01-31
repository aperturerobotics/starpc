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
}  // namespace srpc

namespace starpc {

// ServerRPC represents the server side of an on-going RPC call message stream.
// Matches Go ServerRPC struct in server-rpc.go
class ServerRPC : public CommonRPC, public MsgStreamRw {
 public:
  // Constructor matching NewServerRPC in Go
  ServerRPC(Invoker* invoker, PacketWriter* writer);
  ~ServerRPC() override;

  // HandlePacketData handles an incoming unparsed message packet.
  // Matches Go HandlePacketData in server-rpc.go
  Error HandlePacketData(const std::string& data);

  // HandlePacket handles an incoming parsed message packet.
  // Matches Go HandlePacket in server-rpc.go
  Error HandlePacket(const srpc::Packet& msg);

  // HandleCallStart handles the call start packet.
  // Matches Go HandleCallStart in server-rpc.go
  Error HandleCallStart(const srpc::CallStart& pkt);

  // MsgStreamRw interface implementation
  Error ReadOne(std::string* out) override { return CommonRPC::ReadOne(out); }
  Error WriteCallData(const std::string& data, bool data_is_zero, bool complete, Error err) override {
    return CommonRPC::WriteCallData(data, data_is_zero, complete, err);
  }
  Error WriteCallCancel() override { return CommonRPC::WriteCallCancel(); }

 private:
  // InvokeRPC invokes the RPC after CallStart is received.
  // Matches Go invokeRPC in server-rpc.go
  void InvokeRPC(const std::string& service_id, const std::string& method_id);

  Invoker* invoker_;
  std::thread invoke_thread_;
};

// NewServerRPC constructs a new ServerRPC session.
// Matches Go NewServerRPC function in server-rpc.go
inline std::unique_ptr<ServerRPC> NewServerRPC(Invoker* invoker, PacketWriter* writer) {
  return std::make_unique<ServerRPC>(invoker, writer);
}

}  // namespace starpc
