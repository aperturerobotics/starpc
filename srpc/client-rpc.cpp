// go:build deps_only

#include "client-rpc.hpp"

#include "rpcproto.pb.h"

namespace starpc {

ClientRPC::ClientRPC(const std::string &service, const std::string &method) {
  Init();
  service_ = service;
  method_ = method;
}

ClientRPC::~ClientRPC() = default;

Error ClientRPC::Start(PacketWriter *writer, bool write_first_msg,
                       const std::string &first_msg) {
  if (writer == nullptr) {
    return Error::NilWriter;
  }

  if (IsCanceled()) {
    Cancel();
    writer->Close();
    return Error::Canceled;
  }

  bool first_msg_empty = false;
  Error err = Error::OK;

  {
    std::lock_guard<std::mutex> lock(mtx_);
    writer_ = writer;

    if (write_first_msg) {
      first_msg_empty = first_msg.empty();
    }

    auto pkt =
        NewCallStartPacket(service_, method_, first_msg, first_msg_empty);
    err = writer->WritePacket(*pkt);
    if (err != Error::OK) {
      Cancel();
      writer->Close();
    }
  }

  cv_.notify_all();
  return err;
}

Error ClientRPC::HandlePacketData(const std::string &data) {
  srpc::Packet pkt;
  if (!pkt.ParseFromString(data)) {
    return Error::InvalidMessage;
  }
  return HandlePacket(pkt);
}

void ClientRPC::HandleStreamClose(Error close_err) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (close_err != Error::OK && remote_err_ == Error::OK) {
    remote_err_ = close_err;
  }
  data_closed_ = true;
  Cancel();
  cv_.notify_all();
}

Error ClientRPC::HandlePacket(const srpc::Packet &msg) {
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

Error ClientRPC::HandleCallStart(const srpc::CallStart &pkt) {
  // server-to-client calls not supported
  return Error::UnrecognizedPacket;
}

void ClientRPC::Close() {
  std::lock_guard<std::mutex> lock(mtx_);
  // call did not start yet if writer is nil.
  if (writer_ != nullptr) {
    WriteCallCancelLocked();
    CloseLocked();
  }
}

} // namespace starpc
