#pragma once

#include <string>

#include "google/protobuf/message_lite.h"

namespace starpc {

// Message is the interface for protobuf messages.
// Matches Go Message interface in message.go
// In C++, we use google::protobuf::MessageLite as the base.
using Message = google::protobuf::MessageLite;

// MarshalVT serializes the message to bytes.
// (VT suffix matches vtprotobuf convention used in Go)
inline bool MarshalVT(const Message &msg, std::string *out) {
  return msg.SerializeToString(out);
}

// UnmarshalVT deserializes the message from bytes.
inline bool UnmarshalVT(Message *msg, const std::string &data) {
  return msg->ParseFromString(data);
}

// SizeVT returns the serialized size of the message.
inline size_t SizeVT(const Message &msg) { return msg.ByteSizeLong(); }

} // namespace starpc
