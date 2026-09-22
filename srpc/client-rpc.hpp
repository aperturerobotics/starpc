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
class ClientRPC : public CommonRPC, public MsgStreamRw {
public:
  ClientRPC(const std::string &service, const std::string &method);
  ~ClientRPC() override;

  // Start attaches a borrowed writer and writes CallStart once. The writer must
  // outlive this call and its callbacks. The caller closes a rejected writer.
  Error Start(PacketWriter *writer, bool write_first_msg, const std::string &first_msg);

  // HandlePacketData handles an incoming unparsed message packet.
  Error HandlePacketData(const std::string &data);

  // HandleStreamClose handles the stream closing optionally with an error.
  void HandleStreamClose(Error close_err);

  // HandlePacket handles an incoming parsed message packet.
  Error HandlePacket(const srpc::Packet &pkt);

  // HandleCallStart handles the call start packet.
  Error HandleCallStart(const srpc::CallStart &pkt);

  // Close releases any resources held by the ClientRPC.
  void Close();

  // MsgStreamRw interface implementation
  Error ReadOne(std::string *out) override { return CommonRPC::ReadOne(out); }
  Error WriteCallData(const std::string &data, bool data_is_zero, bool complete,
                      Error err) override {
    return CommonRPC::WriteCallData(data, data_is_zero, complete, err);
  }
  Error WriteCallCancel() override { return CommonRPC::WriteCallCancel(); }
  std::string RemoteErrorMessage() const override { return CommonRPC::RemoteErrorMessage(); }
};

// NewClientRPC constructs a new ClientRPC session.
inline std::unique_ptr<ClientRPC> NewClientRPC(const std::string &service,
                                               const std::string &method) {
  return std::make_unique<ClientRPC>(service, method);
}

} // namespace starpc
