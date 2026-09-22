//go:build deps_only

#include "client.hpp"

namespace starpc {
namespace {

// ClientStream retains the RPC until transport callbacks have stopped. The
// transport and stream share ClientRPC; destroying the writer joins its readers.
class ClientStream final : public Stream {
public:
  ClientStream(std::shared_ptr<ClientRPC> rpc, std::unique_ptr<PacketWriter> writer)
      : rpc_(std::move(rpc)), writer_(std::move(writer)),
        messages_(rpc_.get(), [this] { rpc_->Close(); }, rpc_->StopToken()) {}
  ~ClientStream() override { Close(); }

  Error MsgSend(const Message &message) override { return messages_.MsgSend(message); }
  Error MsgRecv(Message *message) override { return messages_.MsgRecv(message); }
  Error CloseSend() override { return messages_.CloseSend(); }
  std::stop_token StopToken() const override { return rpc_->StopToken(); }
  std::string RemoteErrorMessage() const override { return rpc_->RemoteErrorMessage(); }
  Error Close() override {
    rpc_->Close();
    return Error::OK;
  }

private:
  std::shared_ptr<ClientRPC> rpc_;
  std::unique_ptr<PacketWriter> writer_;
  MsgStream messages_;
};

} // namespace

Error ClientImpl::ExecCall(const std::string &service, const std::string &method, const Message &in,
                           Message *out) {
  auto [stream, err] = NewStream(service, method, &in);
  if (err != Error::OK)
    return err;
  return stream->MsgRecv(out);
}

std::pair<std::unique_ptr<Stream>, Error> ClientImpl::NewStream(const std::string &service,
                                                                const std::string &method,
                                                                const Message *first_msg) {
  if (service.empty())
    return {nullptr, Error::EmptyServiceID};
  if (method.empty())
    return {nullptr, Error::EmptyMethodID};
  std::string first_data;
  if (first_msg != nullptr && !first_msg->SerializeToString(&first_data)) {
    return {nullptr, Error::InvalidMessage};
  }

  // Transport callbacks share the call, without referring to this stack frame.
  auto rpc = std::make_shared<ClientRPC>(service, method);
  auto [writer, err] =
      open_stream_([rpc](const std::string &data) { return rpc->HandlePacketData(data); },
                   [rpc](Error closed) { rpc->HandleStreamClose(closed); });
  if (err != Error::OK) {
    if (writer)
      (void)writer->Close();
    return {nullptr, err};
  }
  err = rpc->Start(writer.get(), first_msg != nullptr, first_data);
  if (err != Error::OK) {
    rpc->Close();
    return {nullptr, err};
  }
  return {std::make_unique<ClientStream>(std::move(rpc), std::move(writer)), Error::OK};
}

} // namespace starpc
