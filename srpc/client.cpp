//go:build deps_only

#include "client.hpp"

namespace starpc {
namespace {

/*
 * ClientStream is the Stream over one opened call. The transport and the
 * stream share the ClientRPC; destroying the writer joins the transport's
 * readers, so the call outlives every callback.
 */
class ClientStream final : public Stream {
public:
	ClientStream(std::shared_ptr<ClientRPC> rpc,
		     std::unique_ptr<PacketWriter> writer)
		: rpc(std::move(rpc)),
		  writer(std::move(writer)),
		  messages(
			  this->rpc.get(), [this] { this->rpc->Close(); },
			  this->rpc->StopToken())
	{
	}
	~ClientStream() override
	{
		Close();
	}

	Error MsgSend(const Message &message) override
	{
		return messages.MsgSend(message);
	}
	Error MsgRecv(Message *message) override
	{
		return messages.MsgRecv(message);
	}
	Error CloseSend() override
	{
		return messages.CloseSend();
	}
	std::stop_token StopToken() const override
	{
		return rpc->StopToken();
	}
	std::string RemoteErrorMessage() const override
	{
		return rpc->RemoteErrorMessage();
	}
	Error Close() override
	{
		rpc->Close();
		return Error::OK;
	}

private:
	/* rpc is shared with the transport callbacks. */
	std::shared_ptr<ClientRPC> rpc;
	std::unique_ptr<PacketWriter> writer;
	MsgStream messages;
};

} // namespace

Error ClientImpl::ExecCall(const std::string &service,
			   const std::string &method, const Message &in,
			   Message *out)
{
	auto [stream, err] = NewStream(service, method, &in);
	if (err != Error::OK)
		return err;
	return stream->MsgRecv(out);
}

std::pair<std::unique_ptr<Stream>, Error>
ClientImpl::NewStream(const std::string &service, const std::string &method,
		      const Message *first_msg)
{
	if (service.empty())
		return {nullptr, Error::EmptyServiceID};
	if (method.empty())
		return {nullptr, Error::EmptyMethodID};

	std::string first_data;
	if (first_msg != nullptr && !first_msg->SerializeToString(&first_data))
		return {nullptr, Error::InvalidMessage};

	/*
	 * Transport callbacks share the call, without referring to this stack
	 * frame.
	 */
	auto rpc = std::make_shared<ClientRPC>(service, method);
	auto [writer, err] = open_stream(
		[rpc](const std::string &data) {
			return rpc->HandlePacketData(data);
		},
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
	return {std::make_unique<ClientStream>(std::move(rpc),
					       std::move(writer)),
		Error::OK};
}

} // namespace starpc
