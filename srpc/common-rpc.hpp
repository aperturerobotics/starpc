#pragma once

#include "errors.hpp"
#include "writer.hpp"

#include <condition_variable>
#include <deque>
#include <mutex>
#include <stop_token>
#include <string>

namespace srpc {
class CallData;
}

namespace starpc {

// CommonRPC coordinates message delivery, half-close, and cancellation for one call.
// Its packet writer must outlive the call and interrupt blocked writes when closed.
class CommonRPC {
public:
  CommonRPC();
  virtual ~CommonRPC();

  // Cancel interrupts reads and transport writes. Repeated cancellation is safe.
  void Cancel();
  bool IsCanceled() const;

  // StopToken lets handlers cancel work outside MsgRecv when the call ends.
  std::stop_token StopToken() const { return stop_source_.get_token(); }

  // GetService and GetMethod remain stable after call startup.
  const std::string &GetService() const { return service_; }
  const std::string &GetMethod() const { return method_; }

  // RemoteErrorMessage retains the peer's diagnostic when ReadOne returns RemoteError.
  std::string RemoteErrorMessage() const;

  // ReadOne drains messages preceding a normal completion. Local cancellation
  // interrupts immediately; an abrupt peer disconnect is not a successful EOF.
  Error ReadOne(std::string *out);
  Error WriteCallData(const std::string &data, bool data_is_zero, bool complete, Error err);
  void HandleStreamClose(Error close_err);
  Error HandleCallCancel();
  Error HandleCallData(const srpc::CallData &pkt);
  Error WriteCallCancel();

protected:
  // Finish publishes the handler's terminal verdict before closing the writer.
  void Finish(Error err);

  // CloseWriter releases the transport outside the state lock, once per call.
  void CloseWriter();

  // state_mutex_ guards call state. write_mutex_ orders outgoing packets and
  // may precede state_mutex_; transport close never waits for write_mutex_.
  mutable std::mutex state_mutex_;
  std::mutex write_mutex_;
  std::condition_variable state_changed_;
  std::string service_;
  std::string method_;

  // writer_ is borrowed until the call and transport callbacks have stopped.
  PacketWriter *writer_ = nullptr;
  bool writer_closed_ = false;
  bool local_completed_ = false;
  bool local_completing_ = false;
  bool canceled_ = false;
  bool data_closed_ = false;
  bool remote_completed_ = false;
  Error remote_error_ = Error::OK;
  std::string remote_error_message_;
  std::deque<std::string> data_queue_;
  size_t queued_bytes_ = 0;
  std::stop_source stop_source_;
};

} // namespace starpc
