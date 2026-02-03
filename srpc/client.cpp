//go:build deps_only

#include "client.hpp"

namespace starpc {

Error ClientImpl::ExecCall(const std::string &service,
                           const std::string &method, const Message &in,
                           Message *out) {
  std::string first_msg;
  if (!in.SerializeToString(&first_msg)) {
    return Error::InvalidMessage;
  }

  auto client_rpc = NewClientRPC(service, method);

  // Open the stream with handlers
  auto [writer, err] = open_stream_(
      [&client_rpc](const std::string &data) -> Error {
        return client_rpc->HandlePacketData(data);
      },
      [&client_rpc](Error close_err) {
        client_rpc->HandleStreamClose(close_err);
      });

  if (err != Error::OK) {
    return err;
  }

  err = client_rpc->Start(writer.get(), true, first_msg);
  if (err != Error::OK) {
    client_rpc->Close();
    return err;
  }

  std::string msg;
  err = client_rpc->ReadOne(&msg);
  if (err != Error::OK) {
    client_rpc->Close();
    return err;
  }

  if (!out->ParseFromString(msg)) {
    client_rpc->Close();
    return Error::InvalidMessage;
  }

  client_rpc->Close();
  return Error::OK;
}

std::pair<std::unique_ptr<Stream>, Error>
ClientImpl::NewStream(const std::string &service, const std::string &method,
                      const Message *first_msg) {
  std::string first_msg_data;
  if (first_msg != nullptr) {
    if (!first_msg->SerializeToString(&first_msg_data)) {
      return {nullptr, Error::InvalidMessage};
    }
  }

  auto client_rpc = std::make_shared<ClientRPC>(service, method);

  // Open the stream with handlers
  auto [writer, err] = open_stream_(
      [client_rpc](const std::string &data) -> Error {
        return client_rpc->HandlePacketData(data);
      },
      [client_rpc](Error close_err) {
        client_rpc->HandleStreamClose(close_err);
      });

  if (err != Error::OK) {
    return {nullptr, err};
  }

  err = client_rpc->Start(writer.get(), first_msg != nullptr, first_msg_data);
  if (err != Error::OK) {
    return {nullptr, err};
  }

  // Create MsgStream with close callback
  // Note: We need to capture writer to extend its lifetime
  auto writer_ptr = writer.release();
  auto stream =
      std::make_unique<MsgStream>(client_rpc.get(), [client_rpc, writer_ptr]() {
        client_rpc->Cancel();
        if (writer_ptr) {
          writer_ptr->Close();
          delete writer_ptr;
        }
      });

  // We need to keep client_rpc alive - in a real implementation
  // we'd use a mechanism to tie its lifetime to the stream.
  // For now, the shared_ptr in the lambda captures keeps it alive.

  return {std::move(stream), Error::OK};
}

} // namespace starpc
