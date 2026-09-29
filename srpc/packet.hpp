#pragma once

#include "errors.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace srpc {
class Packet;
class CallStart;
class CallData;
} // namespace srpc

namespace starpc {

/*
 * CloseHandler receives the transport close outcome for a stream.
 * Matches Go CloseHandler in packet.go.
 */
using CloseHandler = std::function<void(Error close_err)>;

/* PacketHandler receives one parsed packet. Matches Go PacketHandler. */
using PacketHandler = std::function<Error(const srpc::Packet &pkt)>;

/*
 * PacketDataHandler receives one packet before parsing, as its serialized
 * bytes. Matches Go PacketDataHandler in packet.go.
 */
using PacketDataHandler = std::function<Error(const std::string &data)>;

/* NewPacketDataHandler parses each payload and forwards it to handler. */
PacketDataHandler NewPacketDataHandler(PacketHandler handler);

/*
 * ValidatePacket checks a packet's shape: its body is one of the known types
 * and the body's required fields are present.
 */
Error ValidatePacket(const srpc::Packet &pkt);

/* ValidateCallStart requires the service and method IDs to be present. */
Error ValidateCallStart(const srpc::CallStart &pkt);

/*
 * ValidateCallData rejects a packet that carries no data, no completion, no
 * error, and no zero-length marker.
 */
Error ValidateCallData(const srpc::CallData &pkt);

/*
 * NewCallStartPacket builds the CallStart packet that opens a call.
 * data_is_zero marks an intentionally empty first message.
 */
std::unique_ptr<srpc::Packet> NewCallStartPacket(const std::string &service,
						 const std::string &method,
						 const std::string &data,
						 bool data_is_zero);

/*
 * NewCallDataPacket builds one CallData packet. err carries the call's
 * terminal verdict; complete ends the sending side.
 */
std::unique_ptr<srpc::Packet> NewCallDataPacket(const std::string &data,
						bool data_is_zero,
						bool complete, Error err);

/* NewCallCancelPacket builds the packet that cancels the call. */
std::unique_ptr<srpc::Packet> NewCallCancelPacket();

} // namespace starpc
