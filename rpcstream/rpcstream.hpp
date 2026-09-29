#pragma once

#include "rpcstream/read-pump.hpp"
#include "rpcstream/rpcstream.pb.h"
#include "rpcstream/writer.hpp"
#include "srpc/client.hpp"
#include "srpc/invoker.hpp"

#include <functional>
#include <memory>
#include <string>
#include <tuple>

namespace rpcstream {

/*
 * RpcStream carries nested RPC packets for one component connection. Close
 * interrupts Send and Recv and is safe to call concurrently and repeatedly;
 * CloseSend only ends outgoing data.
 */
class RpcStream {
public:
	virtual ~RpcStream() = default;

	/* Send writes one packet to the remote component. */
	virtual starpc::Error Send(const RpcStreamPacket &msg) = 0;

	/* Recv reads the next packet, blocking until one arrives. */
	virtual starpc::Error Recv(RpcStreamPacket *msg) = 0;

	/* CloseSend ends outgoing data without ending the stream. */
	virtual starpc::Error CloseSend() = 0;

	/* Close ends the stream and interrupts blocked Send and Recv. */
	virtual starpc::Error Close() = 0;
};

/*
 * RpcStreamGetter lends the Invoker for component_id until the returned
 * release function runs.
 */
using RpcStreamGetter = std::function<
	std::tuple<starpc::Invoker *, std::function<void()>, starpc::Error>(
		const std::string &component_id)>;

/*
 * OpenRpcStream performs the client-side init/ack handshake. With wait_ack,
 * it blocks for the server's ack and reports RemoteError for a rejected
 * component.
 */
starpc::Error OpenRpcStream(RpcStream *stream, const std::string &component_id,
			    bool wait_ack);

/*
 * HandleRpcStream serves the server side of one nested stream: it answers
 * init, runs the nested handler, and joins it before releasing the Invoker.
 */
starpc::Error HandleRpcStream(std::shared_ptr<RpcStream> stream,
			      RpcStreamGetter getter);

/*
 * StartReadPump returns a writer whose receive thread feeds handler and
 * reports the outcome to closed. Destroying the writer interrupts and joins
 * the thread. The stream is shared by the caller and that thread.
 */
std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error>
StartReadPump(std::shared_ptr<RpcStream> stream,
	      starpc::PacketDataHandler handler, starpc::CloseHandler closed);

/*
 * NewRpcStreamOpenStream adapts a stream factory to the client transport
 * boundary: it opens a stream, performs the handshake, and starts the read
 * pump.
 */
template <typename RpcStreamCaller>
starpc::OpenStreamFunc NewRpcStreamOpenStream(RpcStreamCaller caller,
					      const std::string &component_id,
					      bool wait_ack)
{
	return [caller, component_id,
		wait_ack](starpc::PacketDataHandler handler,
			  starpc::CloseHandler closed)
		       -> std::pair<std::unique_ptr<starpc::PacketWriter>,
				    starpc::Error> {
		auto [stream, err] = caller();
		if (err != starpc::Error::OK)
			return {nullptr, err};
		err = OpenRpcStream(stream.get(), component_id, wait_ack);
		if (err != starpc::Error::OK) {
			stream->Close();
			return {nullptr, err};
		}
		return StartReadPump(std::move(stream), std::move(handler),
				     std::move(closed));
	};
}

/* NewRpcStreamClient builds a Client whose transport is a nested stream. */
template <typename RpcStreamCaller>
std::unique_ptr<starpc::Client>
NewRpcStreamClient(RpcStreamCaller caller, const std::string &component_id,
		   bool wait_ack)
{
	return starpc::NewClient(NewRpcStreamOpenStream(
		std::move(caller), component_id, wait_ack));
}

} // namespace rpcstream
