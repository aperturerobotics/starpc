// go:build deps_only

#include "server-rpc.hpp"

#include "packet.hpp"
#include "rpcproto.pb.h"

namespace starpc {

ServerRPC::ServerRPC(Invoker *invoker, PacketWriter *writer)
    : invoker_(invoker) {
  Init();
  writer_ = writer;
}

ServerRPC::~ServerRPC() {
  if (invoke_thread_.joinable()) {
    invoke_thread_.join();
  }
}

Error ServerRPC::HandlePacketData(const std::string &data) {
  srpc::Packet msg;
  if (!msg.ParseFromString(data)) {
    return Error::InvalidMessage;
  }
  return HandlePacket(msg);
}

Error ServerRPC::HandlePacket(const srpc::Packet &msg) {
  Error err = ValidatePacket(msg);
  if (err != Error::OK) {
    return err;
  }

  switch (msg.body_case()) {
  case srpc::Packet::kCallStart:
    return HandleCallStart(msg.call_start());
  case srpc::Packet::kCallData:
    return HandleCallData(msg.call_data());
  case srpc::Packet::kCallCancel:
    if (msg.call_cancel()) {
      return HandleCallCancel();
    }
    return Error::OK;
  default:
    return Error::OK;
  }
}

Error ServerRPC::HandleCallStart(const srpc::CallStart &pkt) {
  std::lock_guard<std::mutex> lock(mtx_);

  // process start: method and service
  if (!method_.empty() || !service_.empty()) {
    return Error::Completed; // call start must be sent only once
  }
  if (data_closed_) {
    return Error::Completed;
  }

  service_ = pkt.rpc_service();
  method_ = pkt.rpc_method();

  // process first data packet, if included
  if (!pkt.data().empty() || pkt.data_is_zero()) {
    data_queue_.push_back(pkt.data());
  }

  // invoke the rpc in a separate thread (matches Go goroutine)
  std::string service_id = service_;
  std::string method_id = method_;
  cv_.notify_all();

  invoke_thread_ = std::thread(
      [this, service_id, method_id]() { InvokeRPC(service_id, method_id); });

  return Error::OK;
}

void ServerRPC::InvokeRPC(const std::string &service_id,
                          const std::string &method_id) {
  // On the server side, the writer is closed by invokeRPC.
  auto strm = NewMsgStream(this, [this]() { Cancel(); });

  auto [ok, err] = invoker_->InvokeMethod(service_id, method_id, strm.get());
  if (err == Error::OK && !ok) {
    err = Error::Unimplemented;
  }

  auto out_pkt = NewCallDataPacket("", false, true, err);
  writer_->WritePacket(*out_pkt);
  writer_->Close();
  Cancel();
}

} // namespace starpc
