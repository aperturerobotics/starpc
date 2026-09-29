//go:build deps_only

/*
 * Half-close checks for the generated C++ callers. Once the request is
 * written, the half-close is only a notice: a caller that half-closes after
 * the remote ended the call still reads the buffered responses and the
 * call's outcome.
 */

#include "echo/echo_srpc.pb.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/server-rpc.hpp"

#include <cstdlib>
#include <iostream>
#include <latch>

namespace {
using starpc::Error;

const char *body = "hello world via starpc half-close test";

void Check(bool value, const char *message)
{
	if (value)
		return;
	std::cerr << message << '\n';
	std::exit(1);
}

/*
 * OnceEchoServer answers each streaming call once and completes it.
 */
class OnceEchoServer final : public echo::SRPCEchoerServer {
public:
	Error Echo(const echo::EchoMsg &req, echo::EchoMsg *resp) override
	{
		*resp = req;
		return Error::OK;
	}

	Error
	EchoServerStream(const echo::EchoMsg &req,
			 echo::SRPCEchoer_EchoServerStreamStream *strm) override
	{
		return strm->Send(req);
	}

	/*
	 * EchoClientStream replies to the first message without waiting for
	 * the half-close.
	 */
	Error EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream *strm,
			       echo::EchoMsg *resp) override
	{
		return strm->Recv(resp);
	}

	Error EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream *) override
	{
		return Error::Unimplemented;
	}

	Error RpcStream(echo::SRPCEchoer_RpcStreamStream *) override
	{
		return Error::Unimplemented;
	}

	Error DoNothing(const google::protobuf::Empty &,
			google::protobuf::Empty *) override
	{
		return Error::OK;
	}
};

/* FuncWriter forwards packets and the transport close to callbacks. */
class FuncWriter final : public starpc::PacketWriter {
public:
	FuncWriter(std::function<Error(const srpc::Packet &)> write,
		   std::function<void()> close)
		: write(std::move(write)),
		  close(std::move(close))
	{
	}

	Error WritePacket(const srpc::Packet &packet) override
	{
		return write(packet);
	}

	Error Close() override
	{
		close();
		return Error::OK;
	}

private:
	std::function<Error(const srpc::Packet &)> write;
	std::function<void()> close;
};

/*
 * EchoPipe serves OnceEchoServer to one client stream in memory. closed
 * counts down after the client's transport close callback returns.
 */
class EchoPipe {
public:
	EchoPipe()
	{
		auto [handler, err] =
			echo::SRPCRegisterEchoer(mux.get(), &impl);
		Check(err == Error::OK, "register echoer");
		this->handler = std::move(handler);
	}

	/* OpenStream connects the client stream to the server. */
	starpc::OpenStreamFunc OpenStream()
	{
		return [this](starpc::PacketDataHandler on_packet,
			      starpc::CloseHandler on_close) {
			server_writer = std::make_unique<FuncWriter>(
				[on_packet](const srpc::Packet &packet) {
					return on_packet(
						packet.SerializeAsString());
				},
				[this, on_close] {
					on_close(Error::OK);
					closed.count_down();
				});
			server = starpc::NewServerRPC(mux.get(),
						      server_writer.get());
			auto client_writer = std::make_unique<FuncWriter>(
				[this](const srpc::Packet &packet) {
					return server->HandlePacket(packet);
				},
				[this] {
					server->HandleStreamClose(Error::OK);
				});
			return std::make_pair(
				std::unique_ptr<starpc::PacketWriter>(
					std::move(client_writer)),
				Error::OK);
		};
	}

	std::latch closed{1};

private:
	OnceEchoServer impl;
	std::unique_ptr<starpc::Mux> mux = starpc::NewMux();
	std::unique_ptr<echo::SRPCEchoerHandler> handler;
	std::unique_ptr<FuncWriter> server_writer;
	std::unique_ptr<starpc::ServerRPC> server;
};

/*
 * DroppingPipe accepts CallStart, then drops the transport without a
 * response. closed counts down after the client's transport close callback
 * returns.
 */
class DroppingPipe {
public:
	starpc::OpenStreamFunc OpenStream()
	{
		return [this](starpc::PacketDataHandler,
			      starpc::CloseHandler on_close) {
			auto writer = std::make_unique<FuncWriter>(
				[this, on_close](const srpc::Packet &) {
					dropper =
						std::jthread([this, on_close] {
							on_close(Error::EOF_);
							closed.count_down();
						});
					return Error::OK;
				},
				[] {});
			return std::make_pair(
				std::unique_ptr<starpc::PacketWriter>(
					std::move(writer)),
				Error::OK);
		};
	}

	std::latch closed{1};

private:
	std::jthread dropper;
};

/*
 * EndedClient returns each new stream only after its transport has closed,
 * so the generated caller half-closes after the remote already ended the
 * call.
 */
class EndedClient final : public starpc::Client {
public:
	EndedClient(starpc::OpenStreamFunc open_stream, std::latch *closed)
		: client(std::move(open_stream)),
		  closed(closed)
	{
	}

	Error ExecCall(const std::string &service, const std::string &method,
		       const starpc::Message &in, starpc::Message *out) override
	{
		return client.ExecCall(service, method, in, out);
	}

	std::pair<std::unique_ptr<starpc::Stream>, Error>
	NewStream(const std::string &service, const std::string &method,
		  const starpc::Message *first_msg) override
	{
		auto opened = client.NewStream(service, method, first_msg);
		if (opened.second == Error::OK)
			closed->wait();
		return opened;
	}

private:
	starpc::ClientImpl client;
	std::latch *closed;
};

/* ServerStreamCompletedBeforeCloseSend reads a reply after remote completion.
 */
void ServerStreamCompletedBeforeCloseSend()
{
	/* Complete the server stream before the generated caller half-closes.
	 */
	EchoPipe pipe;
	EndedClient client(pipe.OpenStream(), &pipe.closed);
	echo::SRPCEchoerClientImpl echoer(&client);
	echo::EchoMsg req;
	req.set_body(body);
	auto [strm, err] = echoer.EchoServerStream(req);
	Check(err == Error::OK,
	      "server stream discarded after remote completion");

	/* Read the buffered response, then the clean completion. */
	echo::EchoMsg msg;
	Check(strm->Recv(&msg) == Error::OK, "buffered response lost");
	Check(msg.body() == body, "response body");
	Check(strm->Recv(&msg) == Error::EOF_, "expected EOF after completion");
}

/* ClientStreamCompletedBeforeCloseSend reads a reply after a failed half-close.
 */
void ClientStreamCompletedBeforeCloseSend()
{
	EchoPipe pipe;
	auto client = starpc::NewClient(pipe.OpenStream());
	echo::SRPCEchoerClientImpl echoer(client.get());
	auto [strm, err] = echoer.EchoClientStream();
	Check(err == Error::OK, "open client stream");

	/* Send the one request and wait for the call to end. */
	echo::EchoMsg req;
	req.set_body(body);
	Check(strm->Send(req) == Error::OK, "send request");
	pipe.closed.wait();

	/* The half-close fails, but the reply is still readable. */
	echo::EchoMsg msg;
	Check(strm->CloseAndRecv(&msg) == Error::OK, "buffered reply lost");
	Check(msg.body() == body, "reply body");
}

/* ServerStreamTransportFailureBeforeCloseSend reports a dropped transport. */
void ServerStreamTransportFailureBeforeCloseSend()
{
	DroppingPipe pipe;
	EndedClient client(pipe.OpenStream(), &pipe.closed);
	echo::SRPCEchoerClientImpl echoer(&client);
	echo::EchoMsg req;
	req.set_body(body);
	auto [strm, err] = echoer.EchoServerStream(req);
	Check(err == Error::OK,
	      "server stream discarded after transport failure");

	/* Recv reports that the call ended without a verdict. */
	echo::EchoMsg msg;
	Check(strm->Recv(&msg) == Error::ClosedBeforeCompletion,
	      "expected ClosedBeforeCompletion");
}

/*
 * FailedHalfCloseKeepsPendingCompletion keeps the transport's buffered reply
 * when the half-close write fails.
 */
void FailedHalfCloseKeepsPendingCompletion()
{
	/*
	 * The half-close write fails while the transport still holds the
	 * reply and completion it read but has not delivered.
	 */
	starpc::ClientRPC rpc("test", "call");
	FuncWriter writer(
		[](const srpc::Packet &packet) {
			return packet.has_call_data() ? Error::Canceled
						      : Error::OK;
		},
		[] {});
	Check(rpc.Start(&writer, false, "") == Error::OK, "start");
	auto strm = starpc::NewMsgStream(&rpc, [&] { rpc.Close(); });
	Check(strm->CloseSend() == Error::Canceled, "half-close write fails");

	/* The transport delivers what it read, then closes. */
	srpc::CallData reply;
	reply.set_data("reply");
	reply.set_complete(true);
	Check(rpc.HandleCallData(reply) == Error::OK,
	      "deliver pending completion");
	rpc.HandleStreamClose(Error::OK);

	std::string data;
	Check(rpc.ReadOne(&data) == Error::OK && data == "reply",
	      "pending reply lost");
	Check(rpc.ReadOne(&data) == Error::EOF_,
	      "expected EOF after completion");
}

} // namespace

int main()
{
	ServerStreamCompletedBeforeCloseSend();
	ClientStreamCompletedBeforeCloseSend();
	ServerStreamTransportFailureBeforeCloseSend();
	FailedHalfCloseKeepsPendingCompletion();
	std::cout << "Half-close checks passed\n";
}
