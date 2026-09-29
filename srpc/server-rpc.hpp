#pragma once

#include "common-rpc.hpp"
#include "errors.hpp"
#include "invoker.hpp"
#include "msg-stream.hpp"
#include "writer.hpp"

#include <string>
#include <thread>

namespace srpc {
class Packet;
class CallStart;
} // namespace srpc

namespace starpc {

/*
 * ServerRPC is the remote's side of one call: it runs the handler the
 * Invoker selects and cancels and joins it on destruction. The Invoker and
 * PacketWriter must outlive it. HandlePacket calls are serialized by the
 * transport; handlers observe cancellation through Stream::StopToken.
 */
class ServerRPC : public CommonRPC, public MsgStreamRw {
public:
	/* ServerRPC serves one call through invoker, writing via writer. */
	ServerRPC(Invoker *invoker, PacketWriter *writer);
	~ServerRPC() override;

	/* HandlePacketData parses one serialized packet and handles it. */
	Error HandlePacketData(const std::string &data);

	/* HandlePacket validates and dispatches one parsed packet. */
	Error HandlePacket(const srpc::Packet &msg);

	/*
	 * HandleCallStart accepts the call's first packet and runs the
	 * handler on its own thread.
	 */
	Error HandleCallStart(const srpc::CallStart &pkt);

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

private:
	/* InvokeRPC runs the handler and publishes its verdict. */
	void InvokeRPC(const std::string &service_id,
		       const std::string &method_id);

	/* invoker is borrowed; the caller owns it. */
	Invoker *invoker;

	/* invoke_thread is last so it stops before the state it reads. */
	std::jthread invoke_thread;
};

/* NewServerRPC constructs a ServerRPC for one call. */
inline std::unique_ptr<ServerRPC> NewServerRPC(Invoker *invoker,
					       PacketWriter *writer)
{
	return std::make_unique<ServerRPC>(invoker, writer);
}

} // namespace starpc
