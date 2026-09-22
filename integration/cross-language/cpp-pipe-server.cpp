//go:build deps_only

#include "echo/echo_srpc.pb.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/server-rpc.hpp"

#include <array>
#include <csignal>
#include <iostream>
#include <mutex>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

class PipeWriter final : public starpc::PacketWriter {
public:
  starpc::Error WritePacket(const srpc::Packet &packet) override {
    std::lock_guard lock(write_mutex_);
    if (closed_)
      return starpc::Error::Canceled;
    const auto data = packet.SerializeAsString();
    const auto size = static_cast<uint32_t>(data.size());
    const std::array<char, 4> header{static_cast<char>(size), static_cast<char>(size >> 8),
                                     static_cast<char>(size >> 16), static_cast<char>(size >> 24)};
    std::cout.write(header.data(), header.size());
    std::cout.write(data.data(), data.size());
    std::cout.flush();
    return std::cout ? starpc::Error::OK : starpc::Error::Canceled;
  }
  starpc::Error Close() override {
    closed_ = true;
    return starpc::Error::OK;
  }

private:
  std::mutex write_mutex_;
  std::atomic<bool> closed_{false};
};

class PipeEcho final : public echo::SRPCEchoerServer {
public:
  starpc::Error Echo(const echo::EchoMsg &request, echo::EchoMsg *response) override {
    *response = request;
    return starpc::Error::OK;
  }
  starpc::Error EchoServerStream(const echo::EchoMsg &request,
                                 echo::SRPCEchoer_EchoServerStreamStream *stream) override {
    return stream->Send(request);
  }
  starpc::Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream *stream,
                                 echo::EchoMsg *response) override {
    return stream->Recv(response);
  }
  starpc::Error EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream *stream) override {
    echo::EchoMsg message;
    while (true) {
      const auto read = stream->Recv(&message);
      if (read == starpc::Error::EOF_)
        return starpc::Error::OK;
      if (read != starpc::Error::OK)
        return read;
      const auto sent = stream->Send(message);
      if (sent != starpc::Error::OK)
        return sent;
    }
  }
  starpc::Error RpcStream(echo::SRPCEchoer_RpcStreamStream *) override {
    return starpc::Error::Unimplemented;
  }
  starpc::Error DoNothing(const google::protobuf::Empty &, google::protobuf::Empty *) override {
    return starpc::Error::OK;
  }
};

} // namespace

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#else
  std::signal(SIGPIPE, SIG_IGN);
#endif
  PipeEcho service;
  const auto handler = echo::NewSRPCEchoerHandler(&service);
  PipeWriter writer;
  starpc::ServerRPC rpc(handler.get(), &writer);
  while (true) {
    std::array<unsigned char, 4> header{};
    std::cin.read(reinterpret_cast<char *>(header.data()), header.size());
    if (!std::cin)
      break;
    const uint32_t size = static_cast<uint32_t>(header[0]) | static_cast<uint32_t>(header[1]) << 8 |
                          static_cast<uint32_t>(header[2]) << 16 |
                          static_cast<uint32_t>(header[3]) << 24;
    if (size == 0 || size > 10'000'000)
      return 2;
    std::string packet(size, '\0');
    std::cin.read(packet.data(), packet.size());
    if (!std::cin)
      return 2;
    if (rpc.HandlePacketData(packet) != starpc::Error::OK)
      return 2;
  }
  rpc.HandleStreamClose(starpc::Error::EOF_);
}
