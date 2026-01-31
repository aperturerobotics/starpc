#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>

#include "errors.hpp"
#include "writer.hpp"

namespace srpc {
class CallData;
}

namespace starpc {

// CommonRPC contains common logic between server/client RPC.
// Matches Go commonRPC struct in common-rpc.go
class CommonRPC {
 public:
  CommonRPC();
  virtual ~CommonRPC();

  // Init initializes the CommonRPC (matches initCommonRPC in Go).
  void Init();

  // Cancel cancels the RPC context.
  void Cancel();

  // IsCanceled returns true if the RPC has been canceled.
  bool IsCanceled() const;

  // GetService returns the service name.
  const std::string& GetService() const { return service_; }

  // GetMethod returns the method name.
  const std::string& GetMethod() const { return method_; }

  // ReadOne reads a single message and returns.
  // Returns EOF_ if the stream ended without a packet.
  // Matches Go ReadOne in common-rpc.go
  Error ReadOne(std::string* out);

  // WriteCallData writes a call data packet.
  // Matches Go WriteCallData in common-rpc.go
  Error WriteCallData(const std::string& data, bool data_is_zero, bool complete, Error err);

  // HandleStreamClose handles the incoming stream closing with optional error.
  // Matches Go HandleStreamClose in common-rpc.go
  void HandleStreamClose(Error close_err);

  // HandleCallCancel handles the call cancel packet.
  // Matches Go HandleCallCancel in common-rpc.go
  Error HandleCallCancel();

  // HandleCallData handles the call data packet.
  // Matches Go HandleCallData in common-rpc.go
  Error HandleCallData(const srpc::CallData& pkt);

  // WriteCallCancel writes a call cancel packet.
  // Matches Go WriteCallCancel in common-rpc.go
  Error WriteCallCancel();

  // WriteCallCancelLocked is the same as WriteCallCancel but assumes mtx_ is held.
  Error WriteCallCancelLocked();

 protected:
  // CloseLocked releases resources held by the RPC.
  // Must be called with mutex held.
  // Matches Go closeLocked in common-rpc.go
  void CloseLocked();

  // SetWriter sets the packet writer.
  void SetWriter(PacketWriter* writer);

  // Mutex and condition variable for synchronization (replaces Go broadcast)
  mutable std::mutex mtx_;
  std::condition_variable cv_;

  // Service and method names
  std::string service_;
  std::string method_;

  // localCompleted tracks if we have sent a completion or cancel locally.
  // Note: not guarded by mutex (atomic)
  std::atomic<bool> local_completed_{false};

  // Writer to write messages to
  PacketWriter* writer_ = nullptr;

  // dataQueue contains incoming data packets.
  // Note: packets may be empty
  std::deque<std::string> data_queue_;

  // dataClosed is a flag set after dataQueue is closed.
  // Controlled by HandlePacket.
  bool data_closed_ = false;

  // remoteErr is an error set by the remote.
  Error remote_err_ = Error::OK;

  // canceled tracks if the context has been canceled
  std::atomic<bool> canceled_{false};
};

}  // namespace starpc
