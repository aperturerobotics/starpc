#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "errors.hpp"

namespace srpc {
class Packet;
class CallStart;
class CallData;
} // namespace srpc

namespace starpc {

// CloseHandler handles the stream closing with an optional error.
// Matches Go CloseHandler in packet.go
using CloseHandler = std::function<void(Error close_err)>;

// PacketHandler handles a packet.
// Matches Go PacketHandler in packet.go
using PacketHandler = std::function<Error(const srpc::Packet &pkt)>;

// PacketDataHandler handles a packet before it is parsed.
// Matches Go PacketDataHandler in packet.go
using PacketDataHandler = std::function<Error(const std::string &data)>;

// NewPacketDataHandler wraps a PacketHandler with a decoding step.
PacketDataHandler NewPacketDataHandler(PacketHandler handler);

// Validate performs cursory validation of a Packet.
Error ValidatePacket(const srpc::Packet &pkt);

// Validate performs cursory validation of a CallStart.
Error ValidateCallStart(const srpc::CallStart &pkt);

// Validate performs cursory validation of a CallData.
Error ValidateCallData(const srpc::CallData &pkt);

// NewCallStartPacket constructs a new CallStart packet.
std::unique_ptr<srpc::Packet> NewCallStartPacket(const std::string &service,
                                                 const std::string &method,
                                                 const std::string &data,
                                                 bool data_is_zero);

// NewCallDataPacket constructs a new CallData packet.
std::unique_ptr<srpc::Packet> NewCallDataPacket(const std::string &data,
                                                bool data_is_zero,
                                                bool complete, Error err);

// NewCallCancelPacket constructs a new CallCancel packet with cancel.
std::unique_ptr<srpc::Packet> NewCallCancelPacket();

} // namespace starpc
