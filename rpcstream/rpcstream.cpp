//go:build deps_only

#include "rpcstream/rpcstream.hpp"

#include "srpc/rpcproto.pb.h"
#include "srpc/server-rpc.hpp"

#include <system_error>
#include <thread>

namespace rpcstream {
namespace {

// ReadingWriter keeps transport cleanup outside the receive callback; only
// destruction joins the thread, so Close is safe from that thread's callbacks.
class ReadingWriter final : public starpc::PacketWriter {
public:
  ReadingWriter(std::shared_ptr<RpcStream> stream, starpc::PacketDataHandler handler,
                starpc::CloseHandler closed)
      : stream_(std::move(stream)), writer_(stream_),
        reader_(
            [this, handler = std::move(handler), closed = std::move(closed)](std::stop_token stop) {
              std::stop_callback cancel(stop, [this] { stream_->Close(); });
              ReadPump(stream_, handler, closed);
            }) {}
  ~ReadingWriter() override {
    Close();
    reader_.join();
  }
  starpc::Error WritePacket(const srpc::Packet &packet) override {
    return writer_.WritePacket(packet);
  }
  starpc::Error Close() override { return stream_->Close(); }

private:
  std::shared_ptr<RpcStream> stream_;
  RpcStreamWriter writer_;
  std::jthread reader_;
};

} // namespace

RpcStreamWriter::RpcStreamWriter(std::shared_ptr<RpcStream> stream) : stream_(std::move(stream)) {}

starpc::Error RpcStreamWriter::WritePacket(const srpc::Packet &packet) {
  RpcStreamPacket outgoing;
  if (!packet.SerializeToString(outgoing.mutable_data()))
    return starpc::Error::InvalidMessage;
  return stream_->Send(outgoing);
}

starpc::Error RpcStreamWriter::Close() { return stream_->CloseSend(); }

starpc::Error ReadToHandler(RpcStream *stream, starpc::PacketDataHandler handler) {
  while (true) {
    RpcStreamPacket packet;
    const auto received = stream->Recv(&packet);
    if (received != starpc::Error::OK)
      return received;
    if (!packet.has_data())
      return starpc::Error::InvalidMessage;
    const auto handled = handler(packet.data());
    if (handled != starpc::Error::OK)
      return handled;
  }
}

void ReadPump(std::shared_ptr<RpcStream> stream, starpc::PacketDataHandler handler,
              starpc::CloseHandler closed) {
  const auto err = ReadToHandler(stream.get(), std::move(handler));
  if (closed)
    closed(err);
}

std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error>
StartReadPump(std::shared_ptr<RpcStream> stream, starpc::PacketDataHandler handler,
              starpc::CloseHandler closed) {
  try {
    return {std::make_unique<ReadingWriter>(stream, std::move(handler), std::move(closed)),
            starpc::Error::OK};
  } catch (const std::system_error &) {
    stream->Close();
    return {nullptr, starpc::Error::ResourceExhausted};
  }
}

starpc::Error OpenRpcStream(RpcStream *stream, const std::string &component_id, bool wait_ack) {
  RpcStreamPacket init;
  init.mutable_init()->set_component_id(component_id);
  auto err = stream->Send(init);
  if (err != starpc::Error::OK || !wait_ack)
    return err;

  RpcStreamPacket ack;
  err = stream->Recv(&ack);
  if (err != starpc::Error::OK)
    return err;
  if (!ack.has_ack())
    return starpc::Error::InvalidMessage;
  return ack.ack().error().empty() ? starpc::Error::OK : starpc::Error::RemoteError;
}

starpc::Error HandleRpcStream(std::shared_ptr<RpcStream> stream, RpcStreamGetter getter) {
  RpcStreamPacket init;
  auto err = stream->Recv(&init);
  if (err != starpc::Error::OK)
    return err;
  if (!init.has_init())
    return starpc::Error::InvalidMessage;

  auto [invoker, release, lookup_error] = getter(init.init().component_id());
  // The nested call is destroyed inside this scope before its Invoker is released.
  const auto result = [&]() {
    RpcStreamPacket ack;
    auto *body = ack.mutable_ack();
    if (lookup_error == starpc::Error::OK && invoker == nullptr) {
      lookup_error = starpc::Error::Unimplemented;
    }
    if (lookup_error != starpc::Error::OK)
      body->set_error(starpc::ErrorString(lookup_error));
    const auto sent = stream->Send(ack);
    if (sent != starpc::Error::OK)
      return sent;
    if (lookup_error != starpc::Error::OK)
      return lookup_error;

    RpcStreamWriter writer(stream);
    starpc::ServerRPC rpc(invoker, &writer);
    const auto read = ReadToHandler(
        stream.get(), [&](const std::string &data) { return rpc.HandlePacketData(data); });
    rpc.HandleStreamClose(read);
    return read == starpc::Error::EOF_ ? starpc::Error::OK : read;
  }();
  if (release)
    release();
  return result;
}

} // namespace rpcstream
