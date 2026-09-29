#pragma once

#include "client-rpc.hpp"
#include "errors.hpp"
#include "message.hpp"
#include "msg-stream.hpp"
#include "packet.hpp"
#include "stream.hpp"
#include "writer.hpp"

#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace starpc {

/*
 * OpenStreamFunc opens one stream over the transport. It returns the writer
 * the caller writes packets through; msg_handler and close_handler must not
 * be called concurrently. Matches Go OpenStreamFunc in client.go.
 */
using OpenStreamFunc =
	std::function<std::pair<std::unique_ptr<PacketWriter>, Error>(
		PacketDataHandler msg_handler, CloseHandler close_handler)>;

/*
 * Client starts RPC streams over a transport. Matches the Go Client
 * interface in client.go.
 */
class Client {
public:
	virtual ~Client() = default;

	/* ExecCall runs one request/reply RPC and parses the reply into out. */
	virtual Error ExecCall(const std::string &service,
			       const std::string &method, const Message &in,
			       Message *out) = 0;

	/*
	 * NewStream opens a streaming RPC and returns the stream. first_msg,
	 * when set, is sent as the call's first message.
	 */
	virtual std::pair<std::unique_ptr<Stream>, Error>
	NewStream(const std::string &service, const std::string &method,
		  const Message *first_msg) = 0;
};

/*
 * ClientImpl is the default Client over an OpenStreamFunc transport. Matches
 * the Go client struct in client.go.
 */
class ClientImpl : public Client {
public:
	explicit ClientImpl(OpenStreamFunc open_stream)
		: open_stream(std::move(open_stream))
	{
	}

	Error ExecCall(const std::string &service, const std::string &method,
		       const Message &in, Message *out) override;

	std::pair<std::unique_ptr<Stream>, Error>
	NewStream(const std::string &service, const std::string &method,
		  const Message *first_msg) override;

private:
	OpenStreamFunc open_stream;
};

/* NewClient constructs a Client over open_stream. */
inline std::unique_ptr<Client> NewClient(OpenStreamFunc open_stream)
{
	return std::make_unique<ClientImpl>(std::move(open_stream));
}

} // namespace starpc
