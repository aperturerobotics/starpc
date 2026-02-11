//go:build deps_only

// C++ TCP integration server for cross-language testing.
// Listens on TCP, handles one RPC per connection using length-prefixed packets.

#include <arpa/inet.h>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <mutex>
#include <netinet/in.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

#include "echo/echo_srpc.pb.hpp"
#include "rpcstream/rpcstream.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/starpc.hpp"

namespace {

// ReadFull reads exactly n bytes from fd.
bool ReadFull(int fd, void *buf, size_t n) {
  size_t total = 0;
  while (total < n) {
    ssize_t r = read(fd, static_cast<char *>(buf) + total, n - total);
    if (r <= 0)
      return false;
    total += r;
  }
  return true;
}

// WriteFull writes exactly n bytes to fd.
bool WriteFull(int fd, const void *buf, size_t n) {
  size_t total = 0;
  while (total < n) {
    ssize_t w = write(fd, static_cast<const char *>(buf) + total, n - total);
    if (w <= 0)
      return false;
    total += w;
  }
  return true;
}

// TcpPacketWriter writes length-prefixed packets to a TCP socket.
class TcpPacketWriter : public starpc::PacketWriter {
public:
  explicit TcpPacketWriter(int fd) : fd_(fd) {}

  starpc::Error WritePacket(const srpc::Packet &pkt) override {
    std::lock_guard<std::mutex> lock(mtx_);
    std::string data;
    if (!pkt.SerializeToString(&data))
      return starpc::Error::InvalidMessage;

    uint32_t len = static_cast<uint32_t>(data.size());
    // Write LE uint32 length prefix.
    if (!WriteFull(fd_, &len, 4))
      return starpc::Error::EOF_;
    if (!WriteFull(fd_, data.data(), data.size()))
      return starpc::Error::EOF_;
    return starpc::Error::OK;
  }

  starpc::Error Close() override {
    shutdown(fd_, SHUT_WR);
    return starpc::Error::OK;
  }

private:
  int fd_;
  std::mutex mtx_;
};

// EchoServerImpl implements the echo service.
class EchoServerImpl : public echo::SRPCEchoerServer {
public:
  starpc::Error Echo(const echo::EchoMsg &req, echo::EchoMsg *resp) override {
    resp->set_body(req.body());
    return starpc::Error::OK;
  }

  starpc::Error
  EchoServerStream(const echo::EchoMsg &req,
                   echo::SRPCEchoer_EchoServerStreamStream *strm) override {
    for (int i = 0; i < 5; i++) {
      echo::EchoMsg msg;
      msg.set_body(req.body());
      starpc::Error err = strm->Send(msg);
      if (err != starpc::Error::OK)
        return err;
    }
    return starpc::Error::OK;
  }

  starpc::Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream *strm,
                                 echo::EchoMsg *resp) override {
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err != starpc::Error::OK)
      return err;
    resp->set_body(msg.body());
    return starpc::Error::OK;
  }

  starpc::Error
  EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream *strm) override {
    // Send initial message (matches Go server behavior).
    echo::EchoMsg init;
    init.set_body("hello from server");
    starpc::Error err = strm->Send(init);
    if (err != starpc::Error::OK)
      return err;

    while (true) {
      echo::EchoMsg msg;
      err = strm->Recv(&msg);
      if (err == starpc::Error::EOF_)
        break;
      if (err != starpc::Error::OK)
        return err;
      err = strm->Send(msg);
      if (err != starpc::Error::OK)
        return err;
    }
    return starpc::Error::OK;
  }

  starpc::Error RpcStream(echo::SRPCEchoer_RpcStreamStream *) override {
    return starpc::Error::Unimplemented;
  }

  starpc::Error DoNothing(const google::protobuf::Empty &,
                          google::protobuf::Empty *) override {
    return starpc::Error::OK;
  }
};

// HandleConnection handles one TCP connection (one RPC).
void HandleConnection(int fd, starpc::Mux *mux) {
  auto writer = std::make_unique<TcpPacketWriter>(fd);
  auto serverRpc = starpc::NewServerRPC(mux, writer.get());

  while (true) {
    // Read 4-byte LE uint32 length prefix.
    uint32_t len = 0;
    if (!ReadFull(fd, &len, 4))
      break;

    // Read the packet data.
    std::string data(len, '\0');
    if (!ReadFull(fd, data.data(), len))
      break;

    starpc::Error err = serverRpc->HandlePacketData(data);
    if (err != starpc::Error::OK && err != starpc::Error::Completed)
      break;
  }

  close(fd);
}

} // namespace

int main() {
  auto mux = starpc::NewMux();
  EchoServerImpl server;
  auto [handler, err] = echo::SRPCRegisterEchoer(mux.get(), &server);
  if (err != starpc::Error::OK) {
    std::cerr << "register error: " << starpc::ErrorString(err) << std::endl;
    return 1;
  }

  int sockfd = socket(AF_INET, SOCK_STREAM, 0);
  if (sockfd < 0) {
    std::cerr << "socket error" << std::endl;
    return 1;
  }

  int opt = 1;
  setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

  struct sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_port = 0; // OS-assigned port.
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  if (bind(sockfd, reinterpret_cast<struct sockaddr *>(&addr), sizeof(addr)) <
      0) {
    std::cerr << "bind error" << std::endl;
    close(sockfd);
    return 1;
  }

  if (listen(sockfd, 10) < 0) {
    std::cerr << "listen error" << std::endl;
    close(sockfd);
    return 1;
  }

  // Get the assigned port.
  socklen_t addrLen = sizeof(addr);
  getsockname(sockfd, reinterpret_cast<struct sockaddr *>(&addr), &addrLen);
  std::cout << "LISTENING 127.0.0.1:" << ntohs(addr.sin_port) << std::endl;

  while (true) {
    int clientFd = accept(sockfd, nullptr, nullptr);
    if (clientFd < 0)
      break;
    std::thread(HandleConnection, clientFd, mux.get()).detach();
  }

  close(sockfd);
  return 0;
}
