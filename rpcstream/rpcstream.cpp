// go:build deps_only

#include "rpcstream/rpcstream.hpp"

#include "srpc/rpcproto.pb.h"
#include "srpc/server-rpc.hpp"

namespace rpcstream {

RpcStreamWriter::RpcStreamWriter(RpcStream *stream) : stream_(stream) {}

starpc::Error RpcStreamWriter::WritePacket(const srpc::Packet &pkt) {
  std::string data;
  if (!pkt.SerializeToString(&data)) {
    return starpc::Error::InvalidMessage;
  }

  RpcStreamPacket rpc_pkt;
  rpc_pkt.set_data(std::move(data));
  return stream_->Send(rpc_pkt);
}

starpc::Error RpcStreamWriter::Close() { return stream_->CloseSend(); }

starpc::Error ReadToHandler(RpcStream *stream,
                            starpc::PacketDataHandler handler) {
  while (true) {
    RpcStreamPacket pkt;
    starpc::Error err = stream->Recv(&pkt);
    if (err != starpc::Error::OK) {
      return err;
    }

    if (pkt.has_data()) {
      err = handler(pkt.data());
      if (err != starpc::Error::OK) {
        return err;
      }
    }
  }
}

void ReadPump(RpcStream *stream, starpc::PacketDataHandler handler,
              starpc::CloseHandler close_handler) {
  starpc::Error err = ReadToHandler(stream, handler);
  if (err == starpc::Error::EOF_) {
    err = starpc::Error::OK;
  }
  close_handler(err);
}

starpc::Error OpenRpcStream(RpcStream *stream, const std::string &component_id,
                            bool wait_ack) {
  RpcStreamPacket init_pkt;
  init_pkt.mutable_init()->set_component_id(component_id);
  starpc::Error err = stream->Send(init_pkt);
  if (err != starpc::Error::OK) {
    return err;
  }

  if (wait_ack) {
    RpcStreamPacket ack_pkt;
    err = stream->Recv(&ack_pkt);
    if (err != starpc::Error::OK) {
      return err;
    }

    if (!ack_pkt.has_ack()) {
      return starpc::Error::InvalidMessage;
    }

    const std::string &ack_error = ack_pkt.ack().error();
    if (!ack_error.empty()) {
      return starpc::Error::Unimplemented;
    }
  }

  return starpc::Error::OK;
}

starpc::Error HandleRpcStream(RpcStream *stream, RpcStreamGetter getter) {
  // Read and validate init packet
  RpcStreamPacket init_pkt;
  starpc::Error err = stream->Recv(&init_pkt);
  if (err != starpc::Error::OK) {
    return err;
  }

  if (!init_pkt.has_init()) {
    return starpc::Error::InvalidMessage;
  }

  const std::string &component_id = init_pkt.init().component_id();

  // Look up invoker for the component
  auto [invoker, release_fn, lookup_err] = getter(component_id);

  // Send ack with error if lookup failed
  RpcStreamPacket ack_pkt;
  auto *ack = ack_pkt.mutable_ack();
  if (lookup_err != starpc::Error::OK) {
    ack->set_error(starpc::ErrorString(lookup_err));
    stream->Send(ack_pkt);
    return lookup_err;
  }
  if (invoker == nullptr) {
    ack->set_error("component not found");
    stream->Send(ack_pkt);
    return starpc::Error::Unimplemented;
  }

  // Send success ack
  err = stream->Send(ack_pkt);
  if (err != starpc::Error::OK) {
    if (release_fn)
      release_fn();
    return err;
  }

  // Create writer and server RPC to handle the proxied packets
  RpcStreamWriter writer(stream);
  auto server_rpc = starpc::NewServerRPC(invoker, &writer);

  // Forward data packets to the server RPC
  while (true) {
    RpcStreamPacket data_pkt;
    err = stream->Recv(&data_pkt);
    if (err == starpc::Error::EOF_) {
      break;
    }
    if (err != starpc::Error::OK) {
      if (release_fn)
        release_fn();
      return err;
    }

    if (data_pkt.has_data()) {
      err = server_rpc->HandlePacketData(data_pkt.data());
      if (err != starpc::Error::OK && err != starpc::Error::Completed) {
        if (release_fn)
          release_fn();
        return err;
      }
    }
  }

  if (release_fn)
    release_fn();
  return starpc::Error::OK;
}

} // namespace rpcstream
