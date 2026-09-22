//go:build deps_only

#include "echo/echo.pb.h"
#include "rpcstream/rpcstream.hpp"
#include "srpc/client.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/server-rpc.hpp"

#include <atomic>
#include <cstdlib>
#include <future>
#include <iostream>
#include <latch>

namespace {
using starpc::Error;

void Check(bool value, const char *message) {
  if (value)
    return;
  std::cerr << message << '\n';
  std::exit(1);
}

class Writer final : public starpc::PacketWriter {
public:
  Error WritePacket(const srpc::Packet &packet) override {
    if (write)
      return write(packet);
    return Error::OK;
  }
  Error Close() override {
    ++closes;
    if (close)
      close();
    return Error::OK;
  }
  std::function<Error(const srpc::Packet &)> write;
  std::function<void()> close;
  std::atomic<int> closes = 0;
};

class WaitingHandler final : public starpc::Invoker {
public:
  std::pair<bool, Error> InvokeMethod(const std::string &, const std::string &,
                                      starpc::Stream *stream) override {
    entered.count_down();
    echo::EchoMsg message;
    const auto err = stream->MsgRecv(&message);
    exited = true;
    return {true, err};
  }
  std::latch entered{1};
  std::atomic<bool> exited = false;
};

void DestroyWaitingServer() {
  Writer writer;
  WaitingHandler handler;
  {
    starpc::ServerRPC rpc(&handler, &writer);
    srpc::CallStart start;
    start.set_rpc_service("test");
    start.set_rpc_method("wait");
    Check(rpc.HandleCallStart(start) == Error::OK, "start handler");
    handler.entered.wait();
  }
  Check(handler.exited, "server destruction must join the canceled handler");
  Check(writer.closes == 1, "writer closes once");
}

void ReentrantTransport() {
  starpc::ClientRPC rpc("test", "call");
  Writer writer;
  writer.close = [&] { rpc.HandleStreamClose(Error::OK); };
  writer.write = [&](const srpc::Packet &) {
    srpc::CallData data;
    data.set_data("reply");
    data.set_complete(true);
    return rpc.HandleCallData(data);
  };
  Check(rpc.Start(&writer, false, "ignored") == Error::OK, "synchronous reply must not deadlock");
  std::string reply;
  Check(rpc.ReadOne(&reply) == Error::OK && reply == "reply", "deliver synchronous reply");
  Check(rpc.ReadOne(&reply) == Error::EOF_, "explicit completion is EOF");
  rpc.Close();
  rpc.Close();
  Check(writer.closes == 1, "reentrant close must not repeat transport cleanup");
}

void CancelBlockedWriter() {
  Writer writer;
  starpc::ClientRPC rpc("test", "call");
  Check(rpc.Start(&writer, false, "") == Error::OK, "start blocked writer test");
  std::latch writing{1}, closed{1};
  writer.write = [&](const srpc::Packet &) {
    writing.count_down();
    closed.wait();
    return Error::Canceled;
  };
  writer.close = [&] { closed.count_down(); };
  std::jthread sender([&] { (void)rpc.WriteCallData("pending", false, false, Error::OK); });
  writing.wait();
  rpc.Close();
  sender.join();
  Check(writer.closes == 1, "cancellation must interrupt a blocked write");
}

void DisconnectAndErrors() {
  starpc::ClientRPC rpc("test", "call");
  rpc.HandleStreamClose(Error::EOF_);
  std::string message;
  Check(rpc.ReadOne(&message) == Error::ClosedBeforeCompletion, "abrupt EOF is not completion");

  starpc::ClientRPC failed("test", "call");
  srpc::CallData data;
  data.set_error("specific server failure");
  Check(failed.HandleCallData(data) == Error::OK, "receive server error");
  Check(failed.ReadOne(&message) == Error::RemoteError, "preserve remote error kind");
  Check(failed.RemoteErrorMessage() == data.error(), "preserve remote diagnostic");
  auto messages = starpc::NewMsgStream(&failed, [&] { failed.Close(); });
  Check(messages->RemoteErrorMessage() == data.error(), "stream exposes the remote diagnostic");
}

void StreamDestruction() {
  int destroyed = 0;
  struct CountedWriter final : starpc::PacketWriter {
    explicit CountedWriter(int &count) : count_(count) {}
    ~CountedWriter() override { ++count_; }
    Error WritePacket(const srpc::Packet &) override { return Error::OK; }
    Error Close() override { return Error::OK; }
    int &count_;
  };
  auto client = starpc::NewClient([&](auto, auto) {
    return std::make_pair(std::make_unique<CountedWriter>(destroyed), Error::OK);
  });
  {
    auto [stream, err] = client->NewStream("test", "call", nullptr);
    Check(err == Error::OK, "open stream");
    stream->Close();
    stream->Close();
  }
  Check(destroyed == 1, "stream must destroy its writer exactly once");
  {
    auto [stream, err] = client->NewStream("test", "call", nullptr);
    Check(err == Error::OK, "open automatically closed stream");
  }
  Check(destroyed == 2, "dropping a stream must release its writer");
}

void BoundReceiveQueue() {
  starpc::ClientRPC rpc("test", "call");
  srpc::CallData data;
  data.set_data(std::string(4 * 1024 * 1024 + 1, 'x'));
  Check(rpc.HandleCallData(data) == Error::ResourceExhausted, "bound unread message bytes");
  starpc::ClientRPC empty("test", "call");
  data.clear_data();
  data.set_data_is_zero(true);
  for (int i = 0; i < 1024; ++i) {
    Check(empty.HandleCallData(data) == Error::OK, "queue empty message");
  }
  Check(empty.HandleCallData(data) == Error::ResourceExhausted, "bound empty message count");
}

void NestedReleaseWaitsForHandler() {
  WaitingHandler handler;
  class DisconnectStream final : public rpcstream::RpcStream {
  public:
    explicit DisconnectStream(WaitingHandler &handler) : handler_(handler) {}
    Error Send(const rpcstream::RpcStreamPacket &) override { return Error::OK; }
    Error CloseSend() override { return Error::OK; }
    Error Close() override { return Error::OK; }
    Error Recv(rpcstream::RpcStreamPacket *packet) override {
      packet->Clear();
      if (reads_++ == 0) {
        packet->mutable_init()->set_component_id("component");
        return Error::OK;
      }
      if (reads_ == 2) {
        packet->set_data(
            starpc::NewCallStartPacket("test", "wait", "", false)->SerializeAsString());
        return Error::OK;
      }
      handler_.entered.wait();
      return Error::EOF_;
    }

  private:
    WaitingHandler &handler_;
    int reads_ = 0;
  };
  bool released = false;
  auto stream = std::make_shared<DisconnectStream>(handler);
  const auto err = rpcstream::HandleRpcStream(stream, [&](const std::string &) {
    return std::make_tuple(
        &handler,
        [&] {
          Check(handler.exited, "nested handler must return before its service is released");
          released = true;
        },
        Error::OK);
  });
  Check(err == Error::OK && released, "nested disconnect must release its service");
}

void ReceiveThreadJoinsOnDestruction() {
  class WaitingStream final : public rpcstream::RpcStream {
  public:
    Error Send(const rpcstream::RpcStreamPacket &) override { return Error::OK; }
    Error Recv(rpcstream::RpcStreamPacket *) override {
      entered.count_down();
      closed.wait();
      return Error::EOF_;
    }
    Error CloseSend() override { return Close(); }
    Error Close() override {
      if (!stopped.exchange(true))
        closed.count_down();
      return Error::OK;
    }
    std::latch entered{1}, closed{1};
    std::atomic<bool> stopped{false};
  };
  auto stream = std::make_shared<WaitingStream>();
  std::atomic<bool> returned{false};
  auto [writer, started] = rpcstream::StartReadPump(
      stream, [](const std::string &) { return Error::OK; }, [&](Error) { returned = true; });
  Check(started == Error::OK, "start receive thread");
  stream->entered.wait();
  writer.reset();
  Check(returned, "writer destruction must join its receive callback");
}

} // namespace

int main() {
  DestroyWaitingServer();
  ReentrantTransport();
  CancelBlockedWriter();
  DisconnectAndErrors();
  StreamDestruction();
  BoundReceiveQueue();
  NestedReleaseWaitsForHandler();
  ReceiveThreadJoinsOnDestruction();
  std::cout << "RPC lifecycle checks passed\n";
}
