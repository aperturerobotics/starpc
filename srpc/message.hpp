#pragma once

#include <string>

#include "google/protobuf/message_lite.h"

namespace starpc {

/*
 * Message is the wire-message type handed across the RPC boundary. It aliases
 * protobuf's MessageLite, matching the Go Message interface in message.go.
 */
using Message = google::protobuf::MessageLite;

/* MarshalVT serializes msg into out and reports parse success. */
inline bool MarshalVT(const Message &msg, std::string *out)
{
	return msg.SerializeToString(out);
}

/* UnmarshalVT parses data into msg and reports success. */
inline bool UnmarshalVT(Message *msg, const std::string &data)
{
	return msg->ParseFromString(data);
}

/* SizeVT returns the serialized size of msg in bytes. */
inline size_t SizeVT(const Message &msg)
{
	return msg.ByteSizeLong();
}

} // namespace starpc
