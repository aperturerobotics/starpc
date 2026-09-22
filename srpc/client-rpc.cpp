//go:build deps_only

#include "client-rpc.hpp"

#include "rpcproto.pb.h"

namespace starpc {

ClientRPC::ClientRPC(const std::string &service, const std::string &method) {
  service_ = service;
  method_ = method;
}

ClientRPC::~ClientRPC() = default;

Error ClientRPC::Start(PacketWriter *writer, bool write_first_msg, const std::string &first_msg) {
  if (writer == nullptr)
    return Error::NilWriter;
  if (service_.empty())
    return Error::EmptyServiceID;
  if (method_.empty())
    return Error::EmptyMethodID;

  std::unique_lock writing(write_mutex_);
  {
    std::lock_guard lock(state_mutex_);
    if (writer_ != nullptr)
      return Error::Completed;
    writer_ = writer;
    if (canceled_ || data_closed_) {
      writing.unlock();
      // The caller closes a writer rejected before startup.
      return Error::Canceled;
    }
  }
  const auto packet = NewCallStartPacket(service_, method_, write_first_msg ? first_msg : "",
                                         write_first_msg && first_msg.empty());
  const auto written = writer->WritePacket(*packet);
  writing.unlock();
  if (written != Error::OK)
    HandleStreamClose(written);
  return written;
}

Error ClientRPC::HandlePacketData(const std::string &data) {
  srpc::Packet packet;
  if (!packet.ParseFromString(data))
    return Error::InvalidMessage;
  return HandlePacket(packet);
}

void ClientRPC::HandleStreamClose(Error close_err) { CommonRPC::HandleStreamClose(close_err); }

Error ClientRPC::HandlePacket(const srpc::Packet &packet) {
  const auto err = ValidatePacket(packet);
  if (err != Error::OK)
    return err;
  switch (packet.body_case()) {
  case srpc::Packet::kCallStart:
    return Error::UnrecognizedPacket;
  case srpc::Packet::kCallData:
    return HandleCallData(packet.call_data());
  case srpc::Packet::kCallCancel:
    return packet.call_cancel() ? HandleCallCancel() : Error::OK;
  default:
    return Error::UnrecognizedPacket;
  }
}

Error ClientRPC::HandleCallStart(const srpc::CallStart &) { return Error::UnrecognizedPacket; }

void ClientRPC::Close() { Cancel(); }

} // namespace starpc
