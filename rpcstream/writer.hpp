#pragma once

#include "rpcstream/rpcstream.pb.h"
#include "srpc/errors.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/writer.hpp"

namespace rpcstream {

class RpcStream;

// RpcStreamWriter wraps an RpcStream as a PacketWriter.
class RpcStreamWriter : public starpc::PacketWriter {
public:
  explicit RpcStreamWriter(RpcStream *stream);

  // WritePacket serializes the packet and sends it as RpcStreamPacket data.
  starpc::Error WritePacket(const srpc::Packet &pkt) override;

  // Close signals to the remote that no more packets will be sent.
  starpc::Error Close() override;

private:
  RpcStream *stream_;
};

} // namespace rpcstream
