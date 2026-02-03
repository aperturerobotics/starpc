#pragma once

#include <string>

#include "common-rpc.hpp"
#include "errors.hpp"
#include "msg-stream.hpp"
#include "packet.hpp"
#include "writer.hpp"

namespace srpc {
class Packet;
class CallStart;
} // namespace srpc

namespace starpc {

// ClientRPC represents the client side of an on-going RPC call message stream.
// Matches Go ClientRPC struct in client-rpc.go
class ClientRPC : public CommonRPC, public MsgStreamRw {
public:
  // Constructor matching NewClientRPC in Go
  ClientRPC(const std::string &service, const std::string &method);
  ~ClientRPC() override;

  // Start sets the writer and writes the CallStart message.
  // Must only be called once!
  // Matches Go Start method in client-rpc.go
  Error Start(PacketWriter *writer, bool write_first_msg,
              const std::string &first_msg);

  // HandlePacketData handles an incoming unparsed message packet.
  // Matches Go HandlePacketData in client-rpc.go
  Error HandlePacketData(const std::string &data);

  // HandleStreamClose handles the stream closing optionally with an error.
  // Matches Go HandleStreamClose (overrides CommonRPC)
  void HandleStreamClose(Error close_err);

  // HandlePacket handles an incoming parsed message packet.
  // Matches Go HandlePacket in client-rpc.go
  Error HandlePacket(const srpc::Packet &pkt);

  // HandleCallStart handles the call start packet.
  // Matches Go HandleCallStart in client-rpc.go
  Error HandleCallStart(const srpc::CallStart &pkt);

  // Close releases any resources held by the ClientRPC.
  // Matches Go Close in client-rpc.go
  void Close();

  // MsgStreamRw interface implementation
  Error ReadOne(std::string *out) override { return CommonRPC::ReadOne(out); }
  Error WriteCallData(const std::string &data, bool data_is_zero, bool complete,
                      Error err) override {
    return CommonRPC::WriteCallData(data, data_is_zero, complete, err);
  }
  Error WriteCallCancel() override { return CommonRPC::WriteCallCancel(); }
};

// NewClientRPC constructs a new ClientRPC session.
// Matches Go NewClientRPC function in client-rpc.go
inline std::unique_ptr<ClientRPC> NewClientRPC(const std::string &service,
                                               const std::string &method) {
  return std::make_unique<ClientRPC>(service, method);
}

} // namespace starpc
