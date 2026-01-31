//go:build deps_only

#include "common-rpc.hpp"

#include "packet.hpp"
#include "rpcproto.pb.h"

namespace starpc {

CommonRPC::CommonRPC() = default;

CommonRPC::~CommonRPC() = default;

void CommonRPC::Init() {
  canceled_.store(false);
  local_completed_.store(false);
  data_closed_ = false;
  remote_err_ = Error::OK;
  data_queue_.clear();
}

void CommonRPC::Cancel() {
  canceled_.store(true);
  cv_.notify_all();
}

bool CommonRPC::IsCanceled() const {
  return canceled_.load();
}

void CommonRPC::SetWriter(PacketWriter* writer) {
  std::lock_guard<std::mutex> lock(mtx_);
  writer_ = writer;
}

Error CommonRPC::ReadOne(std::string* out) {
  bool ctx_done = false;

  while (true) {
    std::unique_lock<std::mutex> lock(mtx_);

    if (ctx_done && !data_closed_) {
      // context must have been canceled locally
      CloseLocked();
      return Error::Canceled;
    }

    if (!data_queue_.empty()) {
      *out = std::move(data_queue_.front());
      data_queue_.pop_front();
      return Error::OK;
    }

    if (data_closed_ || remote_err_ != Error::OK) {
      if (remote_err_ != Error::OK) {
        return remote_err_;
      }
      return Error::EOF_;
    }

    // Wait for more data or state change
    cv_.wait(lock, [this, &ctx_done]() {
      if (canceled_.load()) {
        ctx_done = true;
        return true;
      }
      return !data_queue_.empty() || data_closed_ || remote_err_ != Error::OK;
    });

    if (canceled_.load()) {
      ctx_done = true;
    }
  }
}

Error CommonRPC::WriteCallData(const std::string& data, bool data_is_zero, bool complete, Error err) {
  // Check if already completed
  if (local_completed_.load()) {
    // If we're just marking completion and already completed, allow it (no-op)
    if (complete && data.empty() && !data_is_zero) {
      return Error::OK;
    }
    // Otherwise, return error for trying to send data after completion
    return Error::Completed;
  }

  // Mark as completed if this call completes the RPC
  if (complete || err != Error::OK) {
    local_completed_.store(true);
  }

  std::lock_guard<std::mutex> lock(mtx_);
  if (writer_ == nullptr) {
    return Error::NilWriter;
  }

  auto pkt = NewCallDataPacket(data, data.empty() && data_is_zero, complete, err);
  return writer_->WritePacket(*pkt);
}

void CommonRPC::HandleStreamClose(Error close_err) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (close_err != Error::OK && remote_err_ == Error::OK) {
    remote_err_ = close_err;
  }
  data_closed_ = true;
  canceled_.store(true);
  if (writer_ != nullptr) {
    writer_->Close();
  }
  cv_.notify_all();
}

Error CommonRPC::HandleCallCancel() {
  HandleStreamClose(Error::Canceled);
  return Error::OK;
}

Error CommonRPC::HandleCallData(const srpc::CallData& pkt) {
  std::lock_guard<std::mutex> lock(mtx_);

  if (data_closed_) {
    // If the packet is just indicating the call is complete, ignore it.
    if (pkt.complete()) {
      return Error::OK;
    }
    // Otherwise, return ErrCompleted (unexpected packet).
    return Error::Completed;
  }

  // Queue data if present
  if (!pkt.data().empty() || pkt.data_is_zero()) {
    data_queue_.push_back(pkt.data());
  }

  bool complete = pkt.complete();
  if (!pkt.error().empty()) {
    complete = true;
    // Store remote error - in a full implementation we might parse the error string
    remote_err_ = Error::Unimplemented;  // Generic remote error
  }

  if (complete) {
    data_closed_ = true;
  }

  cv_.notify_all();
  return Error::OK;
}

Error CommonRPC::WriteCallCancel() {
  std::lock_guard<std::mutex> lock(mtx_);
  return WriteCallCancelLocked();
}

Error CommonRPC::WriteCallCancelLocked() {
  // Use atomic swap to check and set completion atomically
  if (local_completed_.exchange(true)) {
    return Error::Completed;
  }

  if (writer_ == nullptr) {
    return Error::NilWriter;
  }

  auto pkt = NewCallCancelPacket();
  return writer_->WritePacket(*pkt);
}

void CommonRPC::CloseLocked() {
  data_closed_ = true;
  local_completed_.store(true);
  if (remote_err_ == Error::OK) {
    remote_err_ = Error::Canceled;
  }
  if (writer_ != nullptr) {
    writer_->Close();
  }
  cv_.notify_all();
  canceled_.store(true);
}

}  // namespace starpc
