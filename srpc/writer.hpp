#pragma once

#include <functional>
#include <memory>

#include "errors.hpp"

namespace srpc {
class Packet;
}

namespace starpc {

// PacketWriter serializes outgoing packets. Close may run from a receive
// callback or concurrently with a write, and must interrupt blocked I/O without
// joining callbacks. Destruction joins any transport receive threads.
class PacketWriter {
public:
  virtual ~PacketWriter() = default;

  // WritePacket writes a packet to the remote.
  virtual Error WritePacket(const srpc::Packet &pkt) = 0;

  // Close interrupts the transport. Repeated calls are safe.
  virtual Error Close() = 0;
};

// PacketWriterWithClose wraps a PacketWriter with an additional close function.
// Matches packetWriterWithClose in writer.go
class PacketWriterWithClose : public PacketWriter {
public:
  PacketWriterWithClose(std::unique_ptr<PacketWriter> inner, std::function<Error()> close_fn)
      : inner_(std::move(inner)), close_fn_(std::move(close_fn)) {}

  Error WritePacket(const srpc::Packet &pkt) override { return inner_->WritePacket(pkt); }

  Error Close() override {
    Error err = inner_->Close();
    Error err2 = close_fn_();
    if (err != Error::OK)
      return err;
    return err2;
  }

private:
  std::unique_ptr<PacketWriter> inner_;
  std::function<Error()> close_fn_;
};

// NewPacketWriterWithClose wraps a PacketWriter with a close function.
inline std::unique_ptr<PacketWriter> NewPacketWriterWithClose(std::unique_ptr<PacketWriter> prw,
                                                              std::function<Error()> close_fn) {
  return std::make_unique<PacketWriterWithClose>(std::move(prw), std::move(close_fn));
}

} // namespace starpc
