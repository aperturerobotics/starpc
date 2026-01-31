//go:build deps_only

#include "packet.hpp"

#include "rpcproto.pb.h"

namespace starpc {

PacketDataHandler NewPacketDataHandler(PacketHandler handler) {
  return [handler](const std::string& data) -> Error {
    srpc::Packet pkt;
    if (!pkt.ParseFromString(data)) {
      return Error::InvalidMessage;
    }
    return handler(pkt);
  };
}

Error ValidatePacket(const srpc::Packet& pkt) {
  switch (pkt.body_case()) {
    case srpc::Packet::kCallStart:
      return ValidateCallStart(pkt.call_start());
    case srpc::Packet::kCallData:
      return ValidateCallData(pkt.call_data());
    case srpc::Packet::kCallCancel:
      return Error::OK;
    default:
      return Error::UnrecognizedPacket;
  }
}

Error ValidateCallStart(const srpc::CallStart& pkt) {
  if (pkt.rpc_method().empty()) {
    return Error::EmptyMethodID;
  }
  if (pkt.rpc_service().empty()) {
    return Error::EmptyServiceID;
  }
  return Error::OK;
}

Error ValidateCallData(const srpc::CallData& pkt) {
  if (pkt.data().empty() && !pkt.complete() && pkt.error().empty() && !pkt.data_is_zero()) {
    return Error::EmptyPacket;
  }
  return Error::OK;
}

std::unique_ptr<srpc::Packet> NewCallStartPacket(
    const std::string& service,
    const std::string& method,
    const std::string& data,
    bool data_is_zero) {
  auto pkt = std::make_unique<srpc::Packet>();
  auto* call_start = pkt->mutable_call_start();
  call_start->set_rpc_service(service);
  call_start->set_rpc_method(method);
  call_start->set_data(data);
  call_start->set_data_is_zero(data_is_zero);
  return pkt;
}

std::unique_ptr<srpc::Packet> NewCallDataPacket(
    const std::string& data,
    bool data_is_zero,
    bool complete,
    Error err) {
  auto pkt = std::make_unique<srpc::Packet>();
  auto* call_data = pkt->mutable_call_data();
  call_data->set_data(data);
  call_data->set_data_is_zero(data_is_zero);
  call_data->set_complete(err != Error::OK || complete);
  if (err != Error::OK) {
    call_data->set_error(ErrorString(err));
  }
  return pkt;
}

std::unique_ptr<srpc::Packet> NewCallCancelPacket() {
  auto pkt = std::make_unique<srpc::Packet>();
  pkt->set_call_cancel(true);
  return pkt;
}

}  // namespace starpc
