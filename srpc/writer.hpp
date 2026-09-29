#pragma once

#include "errors.hpp"

#include <functional>
#include <memory>

namespace srpc {
class Packet;
}

namespace starpc {

/*
 * PacketWriter writes one packet to the transport. Close may run from a
 * receive callback or concurrently with a write, and must interrupt blocked
 * I/O without joining callbacks. Destruction joins any transport receive
 * threads.
 */
class PacketWriter {
public:
	virtual ~PacketWriter() = default;

	/* WritePacket serializes pkt onto the transport. */
	virtual Error WritePacket(const srpc::Packet &pkt) = 0;

	/* Close interrupts the transport. Repeated calls are safe. */
	virtual Error Close() = 0;
};

/*
 * PacketWriterWithClose forwards writes to an owned writer and runs an extra
 * callback on the first Close. Matches packetWriterWithClose in writer.go.
 */
class PacketWriterWithClose : public PacketWriter {
public:
	/* close_fn runs once, after inner->Close. */
	PacketWriterWithClose(std::unique_ptr<PacketWriter> inner,
			      std::function<Error()> close_fn)
		: inner(std::move(inner)),
		  close_fn(std::move(close_fn))
	{
	}

	Error WritePacket(const srpc::Packet &pkt) override
	{
		return inner->WritePacket(pkt);
	}

	Error Close() override
	{
		/* Report the inner close even when the callback also fails. */
		Error err = inner->Close();
		Error err2 = close_fn();
		if (err != Error::OK)
			return err;
		return err2;
	}

private:
	std::unique_ptr<PacketWriter> inner;
	std::function<Error()> close_fn;
};

/* NewPacketWriterWithClose wraps prw so close_fn runs on the first Close. */
inline std::unique_ptr<PacketWriter>
NewPacketWriterWithClose(std::unique_ptr<PacketWriter> prw,
			 std::function<Error()> close_fn)
{
	return std::make_unique<PacketWriterWithClose>(std::move(prw),
						       std::move(close_fn));
}

} // namespace starpc
