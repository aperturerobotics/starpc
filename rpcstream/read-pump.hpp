#pragma once

#include "rpcstream/rpcstream.pb.h"
#include "srpc/errors.hpp"
#include "srpc/packet.hpp"

#include <memory>

namespace rpcstream {

class RpcStream;

/*
 * ReadToHandler reads packets from stream until it ends and hands each data
 * payload to handler. Returns the error that stopped reading, including
 * EOF_ for a clean end.
 */
starpc::Error ReadToHandler(RpcStream *stream,
			    starpc::PacketDataHandler handler);

/*
 * ReadPump runs ReadToHandler and then calls close_handler with the outcome.
 * The shared stream keeps it alive for the pump's lifetime.
 */
void ReadPump(std::shared_ptr<RpcStream> stream,
	      starpc::PacketDataHandler handler,
	      starpc::CloseHandler close_handler);

} // namespace rpcstream
