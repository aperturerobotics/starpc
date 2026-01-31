#pragma once

#include <functional>
#include <string>

#include "errors.hpp"
#include "message.hpp"
#include "stream.hpp"

namespace starpc {

// MsgStreamRw is the read-write interface for MsgStream.
// Matches Go MsgStreamRw interface in msg-stream.go
class MsgStreamRw {
 public:
  virtual ~MsgStreamRw() = default;

  // ReadOne reads a single message and returns.
  // Returns EOF_ if the stream ended.
  virtual Error ReadOne(std::string* out) = 0;

  // WriteCallData writes a call data packet.
  virtual Error WriteCallData(const std::string& data, bool data_is_zero, bool complete, Error err) = 0;

  // WriteCallCancel writes a call cancel (close) packet.
  virtual Error WriteCallCancel() = 0;
};

// MsgStream implements the stream interface passed to implementations.
// Matches Go MsgStream struct in msg-stream.go
class MsgStream : public Stream {
 public:
  // Constructor matching NewMsgStream in Go
  MsgStream(MsgStreamRw* rw, std::function<void()> close_cb)
      : rw_(rw), close_cb_(std::move(close_cb)) {}

  // MsgSend sends the message to the remote.
  Error MsgSend(const Message& msg) override {
    std::string msg_data;
    if (!msg.SerializeToString(&msg_data)) {
      return Error::InvalidMessage;
    }
    return rw_->WriteCallData(msg_data, msg_data.empty(), false, Error::OK);
  }

  // MsgRecv receives an incoming message from the remote.
  Error MsgRecv(Message* msg) override {
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
  Error CloseSend() override {
    return rw_->WriteCallData("", false, true, Error::OK);
  }

  // Close closes the stream.
  Error Close() override {
    Error err = rw_->WriteCallCancel();
    if (close_cb_) {
      close_cb_();
    }
    return err;
  }

 private:
  MsgStreamRw* rw_;
  std::function<void()> close_cb_;
};

// NewMsgStream constructs a new Stream with a MsgStreamRw.
// Matches Go NewMsgStream function in msg-stream.go
inline std::unique_ptr<MsgStream> NewMsgStream(MsgStreamRw* rw, std::function<void()> close_cb) {
  return std::make_unique<MsgStream>(rw, std::move(close_cb));
}

}  // namespace starpc
