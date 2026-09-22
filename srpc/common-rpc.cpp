//go:build deps_only

#include "common-rpc.hpp"

#include "packet.hpp"
#include "rpcproto.pb.h"

namespace starpc {
namespace {

// These bounds contain an unconsumed stream, including zero-length messages.
constexpr size_t kMaximumQueuedBytes = 4 * 1024 * 1024;
constexpr size_t kMaximumQueuedMessages = 1024;

} // namespace

CommonRPC::CommonRPC() = default;
CommonRPC::~CommonRPC() = default;

void CommonRPC::Cancel() {
  {
    std::lock_guard lock(state_mutex_);
    canceled_ = true;
    local_completed_ = true;
    data_queue_.clear();
    queued_bytes_ = 0;
  }
  state_changed_.notify_all();
  stop_source_.request_stop();
  CloseWriter();
}

bool CommonRPC::IsCanceled() const {
  std::lock_guard lock(state_mutex_);
  return canceled_;
}

std::string CommonRPC::RemoteErrorMessage() const {
  std::lock_guard lock(state_mutex_);
  return remote_error_message_;
}

Error CommonRPC::ReadOne(std::string *out) {
  std::unique_lock lock(state_mutex_);
  state_changed_.wait(lock, [this] { return canceled_ || data_closed_ || !data_queue_.empty(); });
  if (canceled_)
    return remote_error_ != Error::OK ? remote_error_ : Error::Canceled;
  if (!data_queue_.empty()) {
    *out = std::move(data_queue_.front());
    queued_bytes_ -= out->size();
    data_queue_.pop_front();
    return Error::OK;
  }
  return remote_error_ != Error::OK ? remote_error_ : Error::EOF_;
}

Error CommonRPC::WriteCallData(const std::string &data, bool data_is_zero, bool complete,
                               Error err) {
  std::unique_lock writing(write_mutex_);
  PacketWriter *writer;
  {
    std::lock_guard lock(state_mutex_);
    if (canceled_)
      return Error::Canceled;
    if (local_completed_) {
      return complete && data.empty() && !data_is_zero ? Error::OK : Error::Completed;
    }
    if (writer_ == nullptr)
      return Error::NilWriter;
    if (writer_closed_)
      return Error::Completed;
    if (complete || err != Error::OK)
      local_completed_ = true;
    writer = writer_;
  }

  const auto packet = NewCallDataPacket(data, data.empty() && data_is_zero, complete, err);
  const auto written = writer->WritePacket(*packet);
  writing.unlock();
  if (written != Error::OK)
    HandleStreamClose(written);
  return written;
}

void CommonRPC::HandleStreamClose(Error close_err) {
  {
    std::lock_guard lock(state_mutex_);
    if (canceled_)
      return;
    if (close_err == Error::EOF_)
      close_err = Error::OK;
    if (remote_error_ == Error::OK && close_err != Error::OK)
      remote_error_ = close_err;
    if (remote_error_ == Error::OK && !remote_completed_ && !local_completing_) {
      remote_error_ = Error::ClosedBeforeCompletion;
    }
    data_closed_ = true;
  }
  state_changed_.notify_all();
  stop_source_.request_stop();
  CloseWriter();
}

Error CommonRPC::HandleCallCancel() {
  Cancel();
  return Error::OK;
}

Error CommonRPC::HandleCallData(const srpc::CallData &pkt) {
  bool overflow = false;
  {
    std::lock_guard lock(state_mutex_);
    if (canceled_)
      return Error::Canceled;
    if (data_closed_)
      return pkt.complete() ? Error::OK : Error::Completed;
    if (!pkt.data().empty() || pkt.data_is_zero()) {
      overflow = data_queue_.size() >= kMaximumQueuedMessages ||
                 pkt.data().size() > kMaximumQueuedBytes - queued_bytes_;
      if (!overflow) {
        data_queue_.push_back(pkt.data());
        queued_bytes_ += pkt.data().size();
      }
    }
    if (!pkt.error().empty()) {
      remote_error_ = Error::RemoteError;
      remote_error_message_ = pkt.error();
    }
    if (pkt.complete() || remote_error_ != Error::OK) {
      data_closed_ = true;
      remote_completed_ = true;
    }
  }
  if (overflow) {
    HandleStreamClose(Error::ResourceExhausted);
    return Error::ResourceExhausted;
  }
  state_changed_.notify_all();
  return Error::OK;
}

Error CommonRPC::WriteCallCancel() {
  std::unique_lock writing(write_mutex_);
  PacketWriter *writer;
  {
    std::lock_guard lock(state_mutex_);
    if (canceled_ || writer_closed_)
      return Error::Canceled;
    if (local_completed_)
      return Error::Completed;
    if (writer_ == nullptr)
      return Error::NilWriter;
    local_completed_ = true;
    writer = writer_;
  }
  const auto written = writer->WritePacket(*NewCallCancelPacket());
  writing.unlock();
  if (written != Error::OK)
    HandleStreamClose(written);
  return written;
}

void CommonRPC::CloseWriter() {
  PacketWriter *writer;
  {
    std::lock_guard lock(state_mutex_);
    if (writer_closed_ || writer_ == nullptr)
      return;
    writer_closed_ = true;
    writer = writer_;
  }
  (void)writer->Close();
}

void CommonRPC::Finish(Error err) {
  {
    std::lock_guard lock(state_mutex_);
    local_completing_ = true;
  }
  (void)WriteCallData("", false, true, err);
  CloseWriter();
  stop_source_.request_stop();
}

} // namespace starpc
