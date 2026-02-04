#pragma once

#include <memory>

#include "rpcstream/rpcstream.pb.h"
#include "srpc/errors.hpp"
#include "srpc/packet.hpp"

namespace rpcstream {

class RpcStream;

// ReadPump reads data packets from stream and forwards to handler.
// Calls close_handler when the stream ends or on error.
// Uses shared_ptr to ensure the stream stays alive during the read pump.
void ReadPump(std::shared_ptr<RpcStream> stream,
              starpc::PacketDataHandler handler,
              starpc::CloseHandler close_handler);

// ReadToHandler reads data packets to handler until stream closes.
// Returns the error that caused reading to stop (including EOF_).
starpc::Error ReadToHandler(RpcStream *stream,
                            starpc::PacketDataHandler handler);

} // namespace rpcstream
