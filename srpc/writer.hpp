#pragma once

#include <functional>
#include <memory>

#include "errors.hpp"

namespace srpc {
class Packet;
}

namespace starpc {

// PacketWriter is the interface used to write messages to a PacketStream.
// Matches Go interface in writer.go
class PacketWriter {
public:
  virtual ~PacketWriter() = default;

  // WritePacket writes a packet to the remote.
  virtual Error WritePacket(const srpc::Packet &pkt) = 0;

  // Close closes the writer.
  virtual Error Close() = 0;
};

// PacketWriterWithClose wraps a PacketWriter with an additional close function.
// Matches packetWriterWithClose in writer.go
class PacketWriterWithClose : public PacketWriter {
public:
  PacketWriterWithClose(std::unique_ptr<PacketWriter> inner,
                        std::function<Error()> close_fn)
      : inner_(std::move(inner)), close_fn_(std::move(close_fn)) {}

  Error WritePacket(const srpc::Packet &pkt) override {
    return inner_->WritePacket(pkt);
  }

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
inline std::unique_ptr<PacketWriter>
NewPacketWriterWithClose(std::unique_ptr<PacketWriter> prw,
                         std::function<Error()> close_fn) {
  return std::make_unique<PacketWriterWithClose>(std::move(prw),
                                                 std::move(close_fn));
}

} // namespace starpc
