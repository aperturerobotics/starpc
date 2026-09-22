//go:build deps_only

#include "server-rpc.hpp"

#include "packet.hpp"
#include "rpcproto.pb.h"

#include <system_error>

namespace starpc {

ServerRPC::ServerRPC(Invoker *invoker, PacketWriter *writer) : invoker_(invoker) {
  writer_ = writer;
}

ServerRPC::~ServerRPC() {
  Cancel();
  if (invoke_thread_.joinable())
    invoke_thread_.join();
}

Error ServerRPC::HandlePacketData(const std::string &data) {
  srpc::Packet packet;
  if (!packet.ParseFromString(data))
    return Error::InvalidMessage;
  return HandlePacket(packet);
}

Error ServerRPC::HandlePacket(const srpc::Packet &packet) {
  const auto err = ValidatePacket(packet);
  if (err != Error::OK)
    return err;
  switch (packet.body_case()) {
  case srpc::Packet::kCallStart:
    return HandleCallStart(packet.call_start());
  case srpc::Packet::kCallData:
    if (service_.empty())
      return Error::UnrecognizedPacket;
    return HandleCallData(packet.call_data());
  case srpc::Packet::kCallCancel:
    return packet.call_cancel() ? HandleCallCancel() : Error::OK;
  default:
    return Error::UnrecognizedPacket;
  }
}

Error ServerRPC::HandleCallStart(const srpc::CallStart &packet) {
  const auto valid = ValidateCallStart(packet);
  if (valid != Error::OK)
    return valid;
  {
    std::lock_guard lock(state_mutex_);
    if (writer_ == nullptr)
      return Error::NilWriter;
    if (invoker_ == nullptr)
      return Error::Unimplemented;
    if (!service_.empty() || canceled_ || data_closed_)
      return Error::Completed;
    service_ = packet.rpc_service();
    method_ = packet.rpc_method();
  }
  if (!packet.data().empty() || packet.data_is_zero()) {
    srpc::CallData first;
    first.set_data(packet.data());
    first.set_data_is_zero(packet.data_is_zero());
    const auto queued = HandleCallData(first);
    if (queued != Error::OK)
      return queued;
  }

  // Thread creation is the sole throwing runtime boundary in this component.
  try {
    invoke_thread_ = std::jthread([this](std::stop_token stop) {
      std::stop_callback canceled(stop, [this] { Cancel(); });
      InvokeRPC(service_, method_);
    });
  } catch (const std::system_error &) {
    Cancel();
    return Error::ResourceExhausted;
  }
  return Error::OK;
}

void ServerRPC::InvokeRPC(const std::string &service_id, const std::string &method_id) {
  auto stream = NewMsgStream(this, [this] { Cancel(); }, StopToken());
  auto [found, err] = invoker_->InvokeMethod(service_id, method_id, stream.get());
  if (!found && err == Error::OK)
    err = Error::Unimplemented;
  Finish(err);
}

} // namespace starpc
