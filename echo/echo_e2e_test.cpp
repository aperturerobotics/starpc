// go:build deps_only

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
#include "rpcstream/rpcstream.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/starpc.hpp"

namespace {

const char *kTestBody = "hello world via starpc C++ e2e test";

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

  InMemoryTransport()
      : client_endpoint_(std::make_shared<Endpoint>()),
        server_endpoint_(std::make_shared<Endpoint>()) {}

  // Get writer for client to send to server
  std::shared_ptr<Endpoint> ClientToServer() { return server_endpoint_; }
  // Get writer for server to send to client
  std::shared_ptr<Endpoint> ServerToClient() { return client_endpoint_; }
  // Get reader for client (reads from server)
  std::shared_ptr<Endpoint> ClientReader() { return client_endpoint_; }
  // Get reader for server (reads from client)
  std::shared_ptr<Endpoint> ServerReader() { return server_endpoint_; }

  static void Send(std::shared_ptr<Endpoint> ep, const std::string &data) {
    std::lock_guard<std::mutex> lock(ep->mtx);
    if (!ep->closed) {
      ep->packets.push(data);
      ep->cv.notify_all();
    }
  }

  static bool Recv(std::shared_ptr<Endpoint> ep, std::string *out,
                   int timeout_ms = 5000) {
    std::unique_lock<std::mutex> lock(ep->mtx);
    if (!ep->cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&ep]() {
          return !ep->packets.empty() || ep->closed;
        })) {
      return false; // timeout
    }
    if (ep->packets.empty()) {
      return false; // closed
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

  starpc::Error WritePacket(const srpc::Packet &pkt) override {
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

// RpcStreamAdapter adapts generated stream classes to implement
// rpcstream::RpcStream
class RpcStreamAdapter : public rpcstream::RpcStream {
public:
  explicit RpcStreamAdapter(echo::SRPCEchoer_RpcStreamStream *strm)
      : strm_(strm) {}

  starpc::Error Send(const rpcstream::RpcStreamPacket &msg) override {
    return strm_->Send(msg);
  }
  starpc::Error Recv(rpcstream::RpcStreamPacket *msg) override {
    return strm_->Recv(msg);
  }
  starpc::Error CloseSend() override { return starpc::Error::OK; }
  starpc::Error Close() override { return starpc::Error::OK; }

private:
  echo::SRPCEchoer_RpcStreamStream *strm_;
};

// EchoServerImpl implements the echo server.
class EchoServerImpl : public echo::SRPCEchoerServer {
public:
  void SetRpcStreamMux(starpc::Mux *mux) { rpc_stream_mux_ = mux; }

  starpc::Error Echo(const echo::EchoMsg &req, echo::EchoMsg *resp) override {
    resp->set_body(req.body());
    return starpc::Error::OK;
  }

  starpc::Error
  EchoServerStream(const echo::EchoMsg &req,
                   echo::SRPCEchoer_EchoServerStreamStream *strm) override {
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

  starpc::Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream *strm,
                                 echo::EchoMsg *resp) override {
    // Receive first message and return it
    echo::EchoMsg msg;
    starpc::Error err = strm->Recv(&msg);
    if (err != starpc::Error::OK) {
      return err;
    }
    resp->set_body(msg.body());
    return starpc::Error::OK;
  }

  starpc::Error
  EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream *strm) override {
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

  starpc::Error RpcStream(echo::SRPCEchoer_RpcStreamStream *strm) override {
    // Wrap stream to implement rpcstream::RpcStream interface
    RpcStreamAdapter adapter(strm);
    return rpcstream::HandleRpcStream(
        &adapter, [this](const std::string &component_id) {
          if (!rpc_stream_mux_) {
            return std::make_tuple(static_cast<starpc::Invoker *>(nullptr),
                                   std::function<void()>(),
                                   starpc::Error::Unimplemented);
          }
          return std::make_tuple(
              static_cast<starpc::Invoker *>(rpc_stream_mux_),
              std::function<void()>(), starpc::Error::OK);
        });
  }

  starpc::Error DoNothing(const google::protobuf::Empty &req,
                          google::protobuf::Empty *resp) override {
    // Just return OK
    return starpc::Error::OK;
  }

private:
  starpc::Mux *rpc_stream_mux_ = nullptr;
};

// RunServer runs the server-side packet handling loop.
void RunServer(InMemoryTransport *transport, starpc::Mux *mux) {
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
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "Echo");
  auto writer =
      std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

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
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err)
              << std::endl;
    return false;
  }

  // Read response
  std::string resp_data;
  err = client_rpc->ReadOne(&resp_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: ReadOne error: " << starpc::ErrorString(err)
              << std::endl;
    return false;
  }

  echo::EchoMsg resp;
  if (!resp.ParseFromString(resp_data)) {
    std::cerr << "FAILED: Parse response error" << std::endl;
    return false;
  }

  if (resp.body() != kTestBody) {
    std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body()
              << "'" << std::endl;
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

// Test server streaming RPC
bool TestServerStream() {
  std::cout << "Testing ServerStream RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "EchoServerStream");
  auto writer =
      std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

  // Start client receive thread
  auto client_reader = transport.ClientReader();
  std::atomic<bool> client_done{false};
  std::thread client_recv_thread([&client_rpc, &client_reader, &client_done]() {
    while (!client_done.load()) {
      std::string data;
      if (!InMemoryTransport::Recv(client_reader, &data, 100)) {
        continue;
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
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err)
              << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Read 5 responses
  int received = 0;
  for (int i = 0; i < 5; i++) {
    std::string resp_data;
    err = client_rpc->ReadOne(&resp_data);
    if (err != starpc::Error::OK) {
      std::cerr << "FAILED: ReadOne error at message " << i << ": "
                << starpc::ErrorString(err) << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }

    echo::EchoMsg resp;
    if (!resp.ParseFromString(resp_data)) {
      std::cerr << "FAILED: Parse response error at message " << i << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }

    if (resp.body() != kTestBody) {
      std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body()
                << "'" << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }
    received++;
  }

  if (received != 5) {
    std::cerr << "FAILED: Expected 5 messages, got " << received << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Cleanup
  client_rpc->Close();
  writer->Close();
  client_done.store(true);
  InMemoryTransport::Close(transport.ServerReader());

  client_recv_thread.join();
  server_thread.join();

  std::cout << "PASSED" << std::endl;
  return true;
}

// Test client streaming RPC
bool TestClientStream() {
  std::cout << "Testing ClientStream RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "EchoClientStream");
  auto writer =
      std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

  // Start client receive thread
  auto client_reader = transport.ClientReader();
  std::atomic<bool> client_done{false};
  std::thread client_recv_thread([&client_rpc, &client_reader, &client_done]() {
    while (!client_done.load()) {
      std::string data;
      if (!InMemoryTransport::Recv(client_reader, &data, 100)) {
        continue;
      }
      starpc::Error err = client_rpc->HandlePacketData(data);
      if (err != starpc::Error::OK) {
        break;
      }
    }
  });

  // Send request (no initial data for streaming)
  starpc::Error err = client_rpc->Start(writer.get(), false, "");
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err)
              << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Send first message using WriteCallData
  echo::EchoMsg req;
  req.set_body(kTestBody);
  std::string req_data;
  req.SerializeToString(&req_data);

  err = client_rpc->WriteCallData(req_data, false, false, starpc::Error::OK);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: WriteCallData error: " << starpc::ErrorString(err)
              << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Close send side to indicate we're done sending
  err = client_rpc->WriteCallData("", false, true, starpc::Error::OK);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: WriteCallData (close) error: "
              << starpc::ErrorString(err) << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Read response
  std::string resp_data;
  err = client_rpc->ReadOne(&resp_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: ReadOne error: " << starpc::ErrorString(err)
              << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  echo::EchoMsg resp;
  if (!resp.ParseFromString(resp_data)) {
    std::cerr << "FAILED: Parse response error" << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  if (resp.body() != kTestBody) {
    std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body()
              << "'" << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Cleanup
  client_rpc->Close();
  writer->Close();
  client_done.store(true);
  InMemoryTransport::Close(transport.ServerReader());

  client_recv_thread.join();
  server_thread.join();

  std::cout << "PASSED" << std::endl;
  return true;
}

// Test bidirectional streaming RPC
bool TestBidiStream() {
  std::cout << "Testing BidiStream RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "EchoBidiStream");
  auto writer =
      std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

  // Start client receive thread
  auto client_reader = transport.ClientReader();
  std::atomic<bool> client_done{false};
  std::thread client_recv_thread([&client_rpc, &client_reader, &client_done]() {
    while (!client_done.load()) {
      std::string data;
      if (!InMemoryTransport::Recv(client_reader, &data, 100)) {
        continue;
      }
      starpc::Error err = client_rpc->HandlePacketData(data);
      if (err != starpc::Error::OK) {
        break;
      }
    }
  });

  // Send request (no initial data for bidi streaming)
  starpc::Error err = client_rpc->Start(writer.get(), false, "");
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err)
              << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Send 3 messages and receive 3 responses
  for (int i = 0; i < 3; i++) {
    // Send message
    echo::EchoMsg req;
    req.set_body(kTestBody);
    std::string req_data;
    req.SerializeToString(&req_data);

    err = client_rpc->WriteCallData(req_data, false, false, starpc::Error::OK);
    if (err != starpc::Error::OK) {
      std::cerr << "FAILED: WriteCallData error at message " << i << ": "
                << starpc::ErrorString(err) << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }

    // Receive echoed response
    std::string resp_data;
    err = client_rpc->ReadOne(&resp_data);
    if (err != starpc::Error::OK) {
      std::cerr << "FAILED: ReadOne error at message " << i << ": "
                << starpc::ErrorString(err) << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }

    echo::EchoMsg resp;
    if (!resp.ParseFromString(resp_data)) {
      std::cerr << "FAILED: Parse response error at message " << i << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }

    if (resp.body() != kTestBody) {
      std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body()
                << "'" << std::endl;
      client_done.store(true);
      client_recv_thread.join();
      return false;
    }
  }

  // Close send side
  err = client_rpc->WriteCallData("", false, true, starpc::Error::OK);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: WriteCallData (close) error: "
              << starpc::ErrorString(err) << std::endl;
    client_done.store(true);
    client_recv_thread.join();
    return false;
  }

  // Cleanup
  client_rpc->Close();
  writer->Close();
  client_done.store(true);
  InMemoryTransport::Close(transport.ServerReader());

  client_recv_thread.join();
  server_thread.join();

  std::cout << "PASSED" << std::endl;
  return true;
}

// Test DoNothing RPC
bool TestDoNothing() {
  std::cout << "Testing DoNothing RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server
  auto mux = starpc::NewMux();
  EchoServerImpl server_impl;
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Setup client
  auto client_rpc = starpc::NewClientRPC("echo.Echoer", "DoNothing");
  auto writer =
      std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());

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

  // Send request with empty message
  google::protobuf::Empty req;
  std::string req_data;
  req.SerializeToString(&req_data);

  starpc::Error err = client_rpc->Start(writer.get(), true, req_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: Start error: " << starpc::ErrorString(err)
              << std::endl;
    return false;
  }

  // Read response
  std::string resp_data;
  err = client_rpc->ReadOne(&resp_data);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: ReadOne error: " << starpc::ErrorString(err)
              << std::endl;
    return false;
  }

  google::protobuf::Empty resp;
  if (!resp.ParseFromString(resp_data)) {
    std::cerr << "FAILED: Parse response error" << std::endl;
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

// RpcStreamClientAdapter adapts the generated client stream to implement
// rpcstream::RpcStream
class RpcStreamClientAdapter : public rpcstream::RpcStream {
public:
  explicit RpcStreamClientAdapter(echo::SRPCEchoer_RpcStreamClient *strm)
      : strm_(strm) {}

  starpc::Error Send(const rpcstream::RpcStreamPacket &msg) override {
    return strm_->Send(msg);
  }
  starpc::Error Recv(rpcstream::RpcStreamPacket *msg) override {
    return strm_->Recv(msg);
  }
  starpc::Error CloseSend() override { return strm_->CloseSend(); }
  starpc::Error Close() override { return strm_->Close(); }

private:
  echo::SRPCEchoer_RpcStreamClient *strm_;
};

// Test RpcStream RPC
// This test verifies that:
// 1. Client can open an RpcStream to the server
// 2. Server handles the init/ack handshake correctly
// 3. Client can send srpc::Packet data through the RpcStream
// 4. Server forwards packets to the nested mux and returns responses
bool TestRpcStream() {
  std::cout << "Testing RpcStream RPC... " << std::flush;

  InMemoryTransport transport;

  // Setup server with nested mux
  auto mux = starpc::NewMux();
  auto nested_mux = starpc::NewMux();
  EchoServerImpl server_impl;
  server_impl.SetRpcStreamMux(nested_mux.get());

  // Register echo service on both muxes
  auto [handler, reg_err] = echo::SRPCRegisterEchoer(mux.get(), &server_impl);
  if (reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Registration error: " << starpc::ErrorString(reg_err)
              << std::endl;
    return false;
  }

  // Also register on nested mux so it can handle the proxied call
  auto [nested_handler, nested_reg_err] =
      echo::SRPCRegisterEchoer(nested_mux.get(), &server_impl);
  if (nested_reg_err != starpc::Error::OK) {
    std::cerr << "FAILED: Nested registration error: "
              << starpc::ErrorString(nested_reg_err) << std::endl;
    return false;
  }

  // Start server thread
  std::thread server_thread(
      [&transport, &mux]() { RunServer(&transport, mux.get()); });

  // Create an OpenStreamFunc for the outer client
  auto outer_open_stream = [&transport](starpc::PacketDataHandler msg_handler,
                                        starpc::CloseHandler close_handler)
      -> std::pair<std::unique_ptr<starpc::PacketWriter>, starpc::Error> {
    auto writer =
        std::make_unique<InMemoryPacketWriter>(transport.ClientToServer());
    auto client_reader = transport.ClientReader();

    // Start client receive thread
    std::thread([msg_handler, close_handler, client_reader]() {
      while (true) {
        std::string data;
        if (!InMemoryTransport::Recv(client_reader, &data)) {
          close_handler(starpc::Error::EOF_);
          break;
        }
        starpc::Error err = msg_handler(data);
        if (err != starpc::Error::OK) {
          close_handler(err);
          break;
        }
      }
    }).detach();

    return {std::move(writer), starpc::Error::OK};
  };

  // Create outer client
  auto outer_client = starpc::NewClient(outer_open_stream);
  auto echo_client = echo::NewSRPCEchoerClient(outer_client.get());

  // Open RpcStream
  auto [rpc_stream_client, rpc_stream_err] = echo_client->RpcStream();
  if (rpc_stream_err != starpc::Error::OK) {
    std::cerr << "FAILED: RpcStream open error: "
              << starpc::ErrorString(rpc_stream_err) << std::endl;
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Create adapter for the RpcStream client
  RpcStreamClientAdapter adapter(rpc_stream_client.get());

  // Send init packet
  starpc::Error err = rpcstream::OpenRpcStream(&adapter, "", true);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: OpenRpcStream error: " << starpc::ErrorString(err)
              << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Create a writer that wraps the RpcStream adapter
  rpcstream::RpcStreamWriter rpc_writer(&adapter);

  // Create a CallStart packet to call Echo method on the nested mux
  echo::EchoMsg req;
  req.set_body(kTestBody);
  std::string req_data;
  req.SerializeToString(&req_data);

  auto call_start_pkt =
      starpc::NewCallStartPacket("echo.Echoer", "Echo", req_data, false);

  // Send the CallStart packet through the RpcStream
  err = rpc_writer.WritePacket(*call_start_pkt);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: WritePacket error: " << starpc::ErrorString(err)
              << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Read response packet from the RpcStream
  rpcstream::RpcStreamPacket resp_pkt;
  err = adapter.Recv(&resp_pkt);
  if (err != starpc::Error::OK) {
    std::cerr << "FAILED: Recv response error: " << starpc::ErrorString(err)
              << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  if (!resp_pkt.has_data()) {
    std::cerr << "FAILED: Expected data packet in response" << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Parse the srpc::Packet from the data
  srpc::Packet srpc_resp_pkt;
  if (!srpc_resp_pkt.ParseFromString(resp_pkt.data())) {
    std::cerr << "FAILED: Failed to parse srpc::Packet from response"
              << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  if (!srpc_resp_pkt.has_call_data()) {
    std::cerr << "FAILED: Expected CallData in response packet" << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Parse the echo response message
  echo::EchoMsg resp;
  if (!resp.ParseFromString(srpc_resp_pkt.call_data().data())) {
    std::cerr << "FAILED: Failed to parse EchoMsg from CallData" << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  if (resp.body() != kTestBody) {
    std::cerr << "FAILED: Expected '" << kTestBody << "' got '" << resp.body()
              << "'" << std::endl;
    rpc_stream_client->Close();
    InMemoryTransport::Close(transport.ServerReader());
    server_thread.join();
    return false;
  }

  // Cleanup
  rpc_stream_client->Close();
  InMemoryTransport::Close(transport.ServerReader());
  server_thread.join();

  std::cout << "PASSED" << std::endl;
  return true;
}

} // namespace

int main() {
  std::cout << "=== starpc C++ E2E Tests ===" << std::endl;

  int passed = 0;
  int failed = 0;

  if (TestUnary()) {
    passed++;
  } else {
    failed++;
  }

  if (TestServerStream()) {
    passed++;
  } else {
    failed++;
  }

  if (TestClientStream()) {
    passed++;
  } else {
    failed++;
  }

  if (TestBidiStream()) {
    passed++;
  } else {
    failed++;
  }

  if (TestDoNothing()) {
    passed++;
  } else {
    failed++;
  }

  if (TestRpcStream()) {
    passed++;
  } else {
    failed++;
  }

  std::cout << std::endl;
  std::cout << "Results: " << passed << " passed, " << failed << " failed"
            << std::endl;

  return failed > 0 ? 1 : 0;
}
