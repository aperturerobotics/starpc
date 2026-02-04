#pragma once

#include <memory>

#include "rpcstream/rpcstream.pb.h"
#include "srpc/errors.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/writer.hpp"

namespace rpcstream {

class RpcStream;

// RpcStreamWriter wraps a shared_ptr<RpcStream> as a PacketWriter.
// The shared_ptr ensures the stream stays alive as long as the writer exists.
class RpcStreamWriter : public starpc::PacketWriter {
public:
  explicit RpcStreamWriter(std::shared_ptr<RpcStream> stream);

  // WritePacket serializes the packet and sends it as RpcStreamPacket data.
  starpc::Error WritePacket(const srpc::Packet &pkt) override;

  // Close signals to the remote that no more packets will be sent.
  starpc::Error Close() override;

private:
  std::shared_ptr<RpcStream> stream_;
};

} // namespace rpcstream
