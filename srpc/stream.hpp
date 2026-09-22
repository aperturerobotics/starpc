#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <stop_token>
#include <string>

#include "errors.hpp"
#include "message.hpp"

namespace starpc {

// Stream is a handle to an on-going bi-directional or one-directional stream
// RPC handle. Matches Go Stream interface in stream.go
class Stream {
public:
  virtual ~Stream() = default;

  // StopToken interrupts handler work when its RPC ends or is canceled.
  virtual std::stop_token StopToken() const { return {}; }

  // RemoteErrorMessage returns the diagnostic accompanying Error::RemoteError.
  virtual std::string RemoteErrorMessage() const { return {}; }

  // MsgSend sends the message to the remote.
  virtual Error MsgSend(const Message &msg) = 0;

  // MsgRecv receives an incoming message from the remote.
  // Parses the message into the object at msg.
  virtual Error MsgRecv(Message *msg) = 0;

  // CloseSend signals to the remote that we will no longer send any messages.
  virtual Error CloseSend() = 0;

  // Close closes the stream for reading and writing.
  virtual Error Close() = 0;
};

// StreamWithClose wraps a Stream with a close function to call when Close is
// called. Matches streamWithClose in stream.go
class StreamWithClose : public Stream {
public:
  StreamWithClose(Stream *inner, std::function<Error()> close_fn)
      : inner_(inner), close_fn_(std::move(close_fn)) {}

  Error MsgSend(const Message &msg) override { return inner_->MsgSend(msg); }
  Error MsgRecv(Message *msg) override { return inner_->MsgRecv(msg); }
  Error CloseSend() override { return inner_->CloseSend(); }
  std::stop_token StopToken() const override { return inner_->StopToken(); }
  std::string RemoteErrorMessage() const override { return inner_->RemoteErrorMessage(); }

  Error Close() override {
    if (closed_.exchange(true))
      return Error::OK;
    Error err = inner_->Close();
    Error err2 = close_fn_();
    if (err != Error::OK)
      return err;
    return err2;
  }

private:
  Stream *inner_;
  std::function<Error()> close_fn_;
  std::atomic<bool> closed_{false};
};

// NewStreamWithClose wraps a Stream with a close function.
inline std::unique_ptr<Stream> NewStreamWithClose(Stream *strm, std::function<Error()> close_fn) {
  return std::make_unique<StreamWithClose>(strm, std::move(close_fn));
}

} // namespace starpc
