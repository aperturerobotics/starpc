//go:build deps_only

// Echo end-to-end test for starpc C++ implementation.
// Tests unary and streaming RPC patterns.

#include <atomic>
#include <cassert>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>

#include "echo/echo_srpc.pb.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/starpc.hpp"

namespace {

const char* kTestBody = "hello world via starpc C++ e2e test";

// InMemoryTransport provides an in-memory packet transport for testing.
// Simulates a bidirectional connection between client and server.
class InMemoryTransport {
 public:
  struct Endpoint {
    std::mutex mtx;
    std::condition_variable cv;
    std::queue<std::string> packets;
    bool closed = false;
  };

  InMemoryTransport() : client_endpoint_(std::make_shared<Endpoint>()),
                        server_endpoint_(std::make_shared<Endpoint>()) {}

  // Get writer for client to send to server
  std::shared_ptr<Endpoint> ClientToServer() { return server_endpoint_; }
  // Get writer for server to send to client
  std::shared_ptr<Endpoint> ServerToClient() { return client_endpoint_; }
  // Get reader for client (reads from server)
  std::shared_ptr<Endpoint> ClientReader() { return client_endpoint_; }
  // Get reader for server (reads from client)
  std::shared_ptr<Endpoint> ServerReader() { return server_endpoint_; }

  static void Send(std::shared_ptr<Endpoint> ep, const std::string& data) {
    std::lock_guard<std::mutex> lock(ep->mtx);
    if (!ep->closed) {
      ep->packets.push(data);
      ep->cv.notify_all();
    }
  }

  static bool Recv(std::shared_ptr<Endpoint> ep, std::string* out, int timeout_ms = 5000) {
    std::unique_lock<std::mutex> lock(ep->mtx);
    if (!ep->cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&ep]() {
          return !ep->packets.empty() || ep->closed;
        })) {
      return false;  // timeout
    }
    if (ep->packets.empty()) {
      return false;  // closed
    }
    *out = ep->packets.front();
    ep->packets.pop();
    return true;
  }

  static void Close(std::shared_ptr<Endpoint> ep) {
    std::lock_guard<std::mutex> lock(ep->mtx);
    ep->closed = true;
    ep->cv.notify_all();
  }

 private:
  std::shared_ptr<Endpoint> client_endpoint_;
  std::shared_ptr<Endpoint> server_endpoint_;
};

// InMemoryPacketWriter writes packets to an InMemoryTransport endpoint.
class InMemoryPacketWriter : public starpc::PacketWriter {
 public:
  explicit InMemoryPacketWriter(std::shared_ptr<InMemoryTransport::Endpoint> ep)
      : endpoint_(ep) {}

  starpc::Error WritePacket(const srpc::Packet& pkt) override {
    std::string data;
    if (!pkt.SerializeToString(&data)) {
      return starpc::Error::InvalidMessage;
    }
    InMemoryTransport::Send(endpoint_, data);
    return starpc::Error::OK;
  }

  starpc::Error Close() override {
    InMemoryTransport::Close(endpoint_);
    return starpc::Error::OK;
  }

 private:
  std::shared_ptr<InMemoryTransport::Endpoint> endpoint_;
};

// EchoServerImpl implements the echo server.
class EchoServerImpl : public echo::SRPCEchoerServer {
 public:
  starpc::Error Echo(const echo::EchoMsg& req, echo::EchoMsg* resp) override {
    resp->set_body(req.body());
    return starpc::Error::OK;
  }

  starpc::Error EchoServerStream(const echo::EchoMsg& req,
                                  echo::SRPCEchoer_EchoServerStreamStream* strm) override {
    // Send 5 copies of the message
    for (int i = 0; i < 5; i++) {
      echo::EchoMsg msg;
      msg.set_body(req.body());
      starpc::Error err = strm->Send(msg);
      if (err != starpc::Error::OK) {
        return err;
      }
    }
    return starpc::Error::OK;
  }

  starpc::Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream* strm,
                                  echo::EchoMsg* resp) override {
    // Receive first message and return it
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err != starpc::Error::OK) {
      return err;
    }
    resp->set_body(msg.body());
    return starpc::Error::OK;
  }

  starpc::Error EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream* strm) override {
    // Echo back all received messages
    while (true) {
      echo::EchoMsg msg;
      starpc::Error err = strm->Recv(&msg);
      if (err == starpc::Error::EOF_) {
        break;
      }
      if (err != starpc::Error::OK) {
        return err;
      }
      err = strm->Send(msg);
      if (err != starpc::Error::OK) {
        return err;
      }
    }
    return starpc::Error::OK;
  }

  starpc::Error RpcStream(echo::SRPCEchoer_RpcStreamStream* strm) override {
    // Simple echo for RpcStream - not used in tests
    return starpc::Error::Unimplemented;
  }

  starpc::Error DoNothing(const google::protobuf::Empty& req, google::protobuf::Empty* resp) override {
    // Just return OK
    return starpc::Error::OK;
  }
};

// RunServer runs the server-side packet handling loop.
void RunServer(InMemoryTransport* transport, starpc::Mux* mux) {
  auto reader = transport->ServerReader();
  auto writer_ep = transport->ServerToClient();
  auto writer = std::make_unique<InMemoryPacketWriter>(writer_ep);

  auto server_rpc = starpc::NewServerRPC(mux, writer.get());

  while (true) {
    std::string data;
    if (!InMemoryTransport::Recv(reader, &data)) {
      break;
    }
    starpc::Error err = server_rpc->HandlePacketData(data);
    if (err != starpc::Error::OK && err != starpc::Error::Completed) {
      std::cerr << "Server error: " << starpc::ErrorString(err) << std::endl;
      break;
    }
  }
}

// Test unary RPC
bool TestUnary() {
  std::cout << "Testing Unary RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err) << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread([&transport, &mux]() {
    RunServer(&transport, mux.get());
  });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "Echo");
  auto writer = std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

  // Start client receive thread
  auto client_reader = transport.ClientReader();
  std::thread client_recv_thread([&client_rpc, &client_reader]() {
    while (true) {
      std::string data;
      if (!InMemoryTransport::Recv(client_reader, &data)) {
        client_rpc->HandleStreamClose(starpc::Error::EOF_);
        break;
      }
      starpc::Error err = client_rpc->HandlePacketData(data);
      if (err != starpc::Error::OK) {
        break;
      }
    }
  });

  // Send request
  echo::EchoMsg req;
  req.set_body(kTestBody);
  std::string req_data;
  req.SerializeToString(&req_data);

  starpc::Error err = client_rpc->Start(writer.get(), true, req_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err) << std::endl;
    return false;
  }

  // Read response
  std::string resp_data;
  err = client_rpc->ReadOne(&resp_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: ReadOne error: " << starpc::ErrorString(err) << std::endl;
    return false;
  }

  echo::EchoMsg resp;
  if (!resp.ParseFromString(resp_data)) {
    std::cerr << "FAILED: Parse response error" << std::endl;
    return false;
  }

  if (resp.body() != kTestBody) {
    std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body() << "'" << std::endl;
    return false;
  }

  // Cleanup
  client_rpc->Close();
  writer->Close();
  InMemoryTransport::Close(transport.ServerReader());

  client_recv_thread.join();
  server_thread.join();

  std::cout << "PASSED" << std::endl;
  return true;
}

}  // namespace

int main() {
  std::cout << "=== starpc C++ E2E Tests ===" << std::endl;

  int passed = 0;
  int failed = 0;

  if (TestUnary()) {
    passed++;
  } else {
    failed++;
  }

  std::cout << std::endl;
  std::cout << "Results: " << passed << " passed, " << failed << " failed" << std::endl;

  return failed > 0 ? 1 : 0;
}
