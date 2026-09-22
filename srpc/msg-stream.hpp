#pragma once

#include <atomic>
#include <functional>
#include <string>

#include "errors.hpp"
#include "message.hpp"
#include "stream.hpp"

namespace starpc {

// MsgStreamRw is the read-write interface for MsgStream.
class MsgStreamRw {
public:
  virtual ~MsgStreamRw() = default;

  // RemoteErrorMessage returns the peer's retained error text, if any.
  virtual std::string RemoteErrorMessage() const { return {}; }

  // ReadOne reads a single message and returns.
  // Returns EOF_ if the stream ended.
  virtual Error ReadOne(std::string *out) = 0;

  // WriteCallData writes a call data packet.
  virtual Error WriteCallData(const std::string &data, bool data_is_zero, bool complete,
                              Error err) = 0;

  // WriteCallCancel writes a call cancel (close) packet.
  virtual Error WriteCallCancel() = 0;
};

// MsgStream implements the stream interface passed to implementations.
class MsgStream : public Stream {
public:
  MsgStream(MsgStreamRw *rw, std::function<void()> close_cb, std::stop_token stop = {})
      : rw_(rw), close_cb_(std::move(close_cb)), stop_(stop) {}

  std::stop_token StopToken() const override { return stop_; }
  std::string RemoteErrorMessage() const override { return rw_->RemoteErrorMessage(); }

  // MsgSend sends the message to the remote.
  Error MsgSend(const Message &msg) override {
    std::string msg_data;
    if (!msg.SerializeToString(&msg_data)) {
      return Error::InvalidMessage;
    }
    return rw_->WriteCallData(msg_data, msg_data.empty(), false, Error::OK);
  }

  // MsgRecv receives an incoming message from the remote.
  Error MsgRecv(Message *msg) override {
    std::string data;
    Error err = rw_->ReadOne(&data);
    if (err != Error::OK) {
      return err;
    }
    if (!msg->ParseFromString(data)) {
      return Error::InvalidMessage;
    }
    return Error::OK;
  }

  // CloseSend signals to the remote that we will no longer send any messages.
  Error CloseSend() override { return rw_->WriteCallData("", false, true, Error::OK); }

  // Close closes the stream.
  Error Close() override {
    if (closed_.exchange(true))
      return Error::OK;
    if (close_cb_) {
      close_cb_();
      return Error::OK;
    }
    return rw_->WriteCallCancel();
  }

private:
  MsgStreamRw *rw_;
  std::function<void()> close_cb_;
  std::stop_token stop_;
  std::atomic<bool> closed_{false};
};

// NewMsgStream constructs a new Stream with a MsgStreamRw.
inline std::unique_ptr<MsgStream> NewMsgStream(MsgStreamRw *rw, std::function<void()> close_cb,
                                               std::stop_token stop = {}) {
  return std::make_unique<MsgStream>(rw, std::move(close_cb), stop);
}

} // namespace starpc
