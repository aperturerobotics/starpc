#pragma once

#include "rpcstream/rpcstream.pb.h"
#include "srpc/errors.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/writer.hpp"

#include <memory>

namespace rpcstream {

class RpcStream;

/*
 * RpcStreamWriter adapts a shared RpcStream to the PacketWriter boundary. The
 * shared stream stays alive as long as the writer exists.
 */
class RpcStreamWriter : public starpc::PacketWriter {
public:
	explicit RpcStreamWriter(std::shared_ptr<RpcStream> stream);

	/* WritePacket serializes pkt and sends it as RpcStreamPacket data. */
	starpc::Error WritePacket(const srpc::Packet &pkt) override;

	/* Close half-closes the stream: no more packets will be sent. */
	starpc::Error Close() override;

private:
	std::shared_ptr<RpcStream> stream;
};

} // namespace rpcstream
