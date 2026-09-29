#pragma once

#include "common-rpc.hpp"
#include "errors.hpp"
#include "msg-stream.hpp"
#include "packet.hpp"
#include "writer.hpp"

#include <string>

namespace srpc {
class Packet;
class CallStart;
} // namespace srpc

namespace starpc {

/*
 * ClientRPC is the caller's side of one call. The transport feeds it packets
 * through HandlePacketData and it writes through the PacketWriter given to
 * Start.
 */
class ClientRPC : public CommonRPC, public MsgStreamRw {
public:
	/* ClientRPC opens a call for service and method. */
	ClientRPC(const std::string &service, const std::string &method);
	~ClientRPC() override;

	/*
	 * Start attaches a borrowed writer and writes CallStart once. The
	 * writer must outlive this call and its callbacks. The caller closes
	 * a rejected writer.
	 */
	Error Start(PacketWriter *writer, bool write_first_msg,
		    const std::string &first_msg);

	/* HandlePacketData parses one serialized packet and handles it. */
	Error HandlePacketData(const std::string &data);

	/* HandleStreamClose records the transport ending with its outcome. */
	void HandleStreamClose(Error close_err);

	/* HandlePacket validates and dispatches one parsed packet. */
	Error HandlePacket(const srpc::Packet &pkt);

	/*
	 * HandleCallStart rejects a CallStart: the caller never receives one.
	 */
	Error HandleCallStart(const srpc::CallStart &pkt);

	/* Close cancels the call. */
	void Close();

	/* MsgStreamRw over the shared call state. */
	Error ReadOne(std::string *out) override
	{
		return CommonRPC::ReadOne(out);
	}
	Error WriteCallData(const std::string &data, bool data_is_zero,
			    bool complete, Error err) override
	{
		return CommonRPC::WriteCallData(data, data_is_zero, complete,
						err);
	}
	Error WriteCallCancel() override
	{
		return CommonRPC::WriteCallCancel();
	}
	std::string RemoteErrorMessage() const override
	{
		return CommonRPC::RemoteErrorMessage();
	}
};

/* NewClientRPC constructs a ClientRPC for service and method. */
inline std::unique_ptr<ClientRPC> NewClientRPC(const std::string &service,
					       const std::string &method)
{
	return std::make_unique<ClientRPC>(service, method);
}

} // namespace starpc
