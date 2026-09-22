#pragma once

#include <stdexcept>
#include <string>

namespace starpc {

// Error codes matching Go starpc errors (see errors.go)
enum class Error {
  OK = 0,
  Unimplemented,          // ErrUnimplemented - RPC method was not implemented
  Completed,              // ErrCompleted - unexpected packet after rpc was completed
  UnrecognizedPacket,     // ErrUnrecognizedPacket - unrecognized packet type
  EmptyPacket,            // ErrEmptyPacket - invalid empty packet
  InvalidMessage,         // ErrInvalidMessage - message failed to parse
  EmptyMethodID,          // ErrEmptyMethodID - method id empty
  EmptyServiceID,         // ErrEmptyServiceID - service id empty
  NoAvailableClients,     // ErrNoAvailableClients - no available rpc clients
  NilWriter,              // ErrNilWriter - writer cannot be nil
  Canceled,               // context.Canceled equivalent
  EOF_,                   // io.EOF equivalent (named EOF_ to avoid macro collision)
  ClosedBeforeCompletion, // The transport ended without the peer's verdict.
  ResourceExhausted,      // The call exceeded its receive queue or thread capacity.
  RemoteError,            // RemoteErrorMessage retains the peer's diagnostic.
};

// Convert Error to string (matches Go error messages)
inline const char *ErrorString(Error err) {
  switch (err) {
  case Error::OK:
    return "ok";
  case Error::Unimplemented:
    return "unimplemented";
  case Error::Completed:
    return "unexpected packet after rpc was completed";
  case Error::UnrecognizedPacket:
    return "unrecognized packet type";
  case Error::EmptyPacket:
    return "invalid empty packet";
  case Error::InvalidMessage:
    return "invalid message";
  case Error::EmptyMethodID:
    return "method id empty";
  case Error::EmptyServiceID:
    return "service id empty";
  case Error::NoAvailableClients:
    return "no available rpc clients";
  case Error::NilWriter:
    return "writer cannot be nil";
  case Error::Canceled:
    return "canceled";
  case Error::EOF_:
    return "EOF";
  case Error::ClosedBeforeCompletion:
    return "stream closed before the remote reported completion";
  case Error::ResourceExhausted:
    return "RPC resource limit exceeded";
  case Error::RemoteError:
    return "remote RPC error";
  default:
    return "unknown error";
  }
}

// StarpcError exception for error propagation
class StarpcError : public std::runtime_error {
public:
  explicit StarpcError(Error code) : std::runtime_error(ErrorString(code)), code_(code) {}

  StarpcError(Error code, const std::string &message) : std::runtime_error(message), code_(code) {}

  Error code() const noexcept { return code_; }

private:
  Error code_;
};

} // namespace starpc
