//go:build deps_only

/*
 * Echo end-to-end test for the starpc C++ implementation: unary, streaming,
 * and nested RpcStream calls over an in-memory transport.
 */

#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <tuple>
#include <utility>

#include "echo/echo_srpc.pb.hpp"
#include "rpcstream/rpcstream.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/starpc.hpp"

namespace {

const char *test_body = "hello world via starpc C++ e2e test";

/*
 * InMemoryTransport is a bidirectional packet connection between a test
 * client and server. Each Endpoint queues packets and wakes its readers on
 * send or close.
 */
class InMemoryTransport {
public:
	struct Endpoint {
		std::mutex mtx;
		std::condition_variable cv;
		std::queue<std::string> packets;
		bool closed = false;
	};

	InMemoryTransport()
		: client_endpoint(std::make_shared<Endpoint>()),
		  server_endpoint(std::make_shared<Endpoint>())
	{
	}

	/* ClientToServer returns the endpoint the client writes to. */
	std::shared_ptr<Endpoint> ClientToServer()
	{
		return server_endpoint;
	}
	/* ServerToClient returns the endpoint the server writes to. */
	std::shared_ptr<Endpoint> ServerToClient()
	{
		return client_endpoint;
	}
	/* ClientReader returns the endpoint the client reads from. */
	std::shared_ptr<Endpoint> ClientReader()
	{
		return client_endpoint;
	}
	/* ServerReader returns the endpoint the server reads from. */
	std::shared_ptr<Endpoint> ServerReader()
	{
		return server_endpoint;
	}

	/* Send queues data on ep and wakes its readers. */
	static void Send(std::shared_ptr<Endpoint> ep, const std::string &data)
	{
		std::lock_guard<std::mutex> lock(ep->mtx);
		if (!ep->closed) {
			ep->packets.push(data);
			ep->cv.notify_all();
		}
	}

	/*
	 * Recv waits for one packet and returns false once ep is closed and
	 * drained.
	 */
	static bool Recv(std::shared_ptr<Endpoint> ep, std::string *out)
	{
		std::unique_lock<std::mutex> lock(ep->mtx);
		ep->cv.wait(lock, [&ep]() {
			return !ep->packets.empty() || ep->closed;
		});
		if (ep->packets.empty())
			return false;
		*out = std::move(ep->packets.front());
		ep->packets.pop();
		return true;
	}

	/* Close ends the endpoint and wakes its readers. */
	static void Close(std::shared_ptr<Endpoint> ep)
	{
		std::lock_guard<std::mutex> lock(ep->mtx);
		ep->closed = true;
		ep->cv.notify_all();
	}

private:
	std::shared_ptr<Endpoint> client_endpoint;
	std::shared_ptr<Endpoint> server_endpoint;
};

/* InMemoryPacketWriter writes packets to one transport endpoint. */
class InMemoryPacketWriter : public starpc::PacketWriter {
public:
	explicit InMemoryPacketWriter(
		std::shared_ptr<InMemoryTransport::Endpoint> ep)
		: endpoint(ep)
	{
	}

	starpc::Error WritePacket(const srpc::Packet &pkt) override
	{
		std::string data;
		if (!pkt.SerializeToString(&data))
			return starpc::Error::InvalidMessage;
		InMemoryTransport::Send(endpoint, data);
		return starpc::Error::OK;
	}

	starpc::Error Close() override
	{
		InMemoryTransport::Close(endpoint);
		return starpc::Error::OK;
	}

private:
	std::shared_ptr<InMemoryTransport::Endpoint> endpoint;
};

/*
 * RpcStreamAdapter exposes a generated server stream as an
 * rpcstream::RpcStream. The stream is borrowed and must outlive the adapter.
 */
class RpcStreamAdapter : public rpcstream::RpcStream {
public:
	explicit RpcStreamAdapter(echo::SRPCEchoer_RpcStreamStream *strm)
		: strm(strm)
	{
	}

	starpc::Error Send(const rpcstream::RpcStreamPacket &msg) override
	{
		return strm->Send(msg);
	}
	starpc::Error Recv(rpcstream::RpcStreamPacket *msg) override
	{
		return strm->Recv(msg);
	}
	starpc::Error CloseSend() override
	{
		return starpc::Error::OK;
	}
	starpc::Error Close() override
	{
		return starpc::Error::OK;
	}

private:
	echo::SRPCEchoer_RpcStreamStream *strm;
};

/* EchoServerImpl implements the echo service under test. */
class EchoServerImpl : public echo::SRPCEchoerServer {
public:
	/* SetRpcStreamMux selects the mux nested RpcStream calls resolve to. */
	void SetRpcStreamMux(starpc::Mux *mux)
	{
		rpc_stream_mux = mux;
	}

	starpc::Error Echo(const echo::EchoMsg &req,
			   echo::EchoMsg *resp) override
	{
		resp->set_body(req.body());
		return starpc::Error::OK;
	}

	starpc::Error
	EchoServerStream(const echo::EchoMsg &req,
			 echo::SRPCEchoer_EchoServerStreamStream *strm) override
	{
		/* Send 5 copies of the message */
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

	starpc::Error
	EchoClientStream(echo::SRPCEchoer_EchoClientStreamStream *strm,
			 echo::EchoMsg *resp) override
	{
		/* Receive first message and return it */
		echo::EchoMsg msg;
		starpc::Error err = strm->Recv(&msg);
		if (err != starpc::Error::OK) {
			return err;
		}
		resp->set_body(msg.body());
		return starpc::Error::OK;
	}

	starpc::Error
	EchoBidiStream(echo::SRPCEchoer_EchoBidiStreamStream *strm) override
	{
		/* Echo back all received messages */
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

	starpc::Error RpcStream(echo::SRPCEchoer_RpcStreamStream *strm) override
	{
		auto adapter = std::make_shared<RpcStreamAdapter>(strm);
		return rpcstream::HandleRpcStream(
			adapter, [this](const std::string &component_id) {
				if (!rpc_stream_mux) {
					return std::make_tuple(
						static_cast<starpc::Invoker *>(
							nullptr),
						std::function<void()>(),
						starpc::Error::Unimplemented);
				}
				return std::make_tuple(
					static_cast<starpc::Invoker *>(
						rpc_stream_mux),
					std::function<void()>(),
					starpc::Error::OK);
			});
	}

	starpc::Error DoNothing(const google::protobuf::Empty &req,
				google::protobuf::Empty *resp) override
	{
		return starpc::Error::OK;
	}

private:
	/* rpc_stream_mux is borrowed; the caller owns it. */
	starpc::Mux *rpc_stream_mux = nullptr;
};

/* RunServer serves packets from the transport until it closes. */
void RunServer(InMemoryTransport *transport, starpc::Mux *mux)
{
	auto reader = transport->ServerReader();
	auto writer = std::make_unique<InMemoryPacketWriter>(
		transport->ServerToClient());
	auto server_rpc = starpc::NewServerRPC(mux, writer.get());

	std::string data;
	while (InMemoryTransport::Recv(reader, &data)) {
		starpc::Error err = server_rpc->HandlePacketData(data);
		if (err != starpc::Error::OK &&
		    err != starpc::Error::Completed) {
			std::cerr
				<< "Server error: " << starpc::ErrorString(err)
				<< std::endl;
			break;
		}
	}
}

/*
 * EchoServer serves one EchoServerImpl on a mux, and on a nested mux that
 * RpcStream calls resolve to. It owns the handlers both muxes borrow.
 */
struct EchoServer {
	EchoServerImpl impl;
	std::unique_ptr<echo::SRPCEchoerHandler> handler;
	std::unique_ptr<echo::SRPCEchoerHandler> nested_handler;
	std::unique_ptr<starpc::Mux> mux = starpc::NewMux();
	std::unique_ptr<starpc::Mux> nested_mux = starpc::NewMux();

	/* Register registers impl on both muxes and reports the first error. */
	starpc::Error Register()
	{
		impl.SetRpcStreamMux(nested_mux.get());
		starpc::Error err;
		std::tie(handler, err) =
			echo::SRPCRegisterEchoer(mux.get(), &impl);
		if (err != starpc::Error::OK)
			return err;
		std::tie(nested_handler, err) =
			echo::SRPCRegisterEchoer(nested_mux.get(), &impl);
		return err;
	}
};

/*
 * TestCall serves a mux over an in-memory transport and opens one client call
 * on it. Its receive thread feeds server packets to the call and ends the call
 * with EOF when the transport closes. Destroying the TestCall closes the call
 * and both endpoints and joins both threads, so every exit path releases them.
 * The mux must outlive the TestCall.
 */
class TestCall {
public:
	TestCall(starpc::Mux *mux, const std::string &service,
		 const std::string &method)
		: client_rpc(starpc::NewClientRPC(service, method)),
		  writer(std::make_unique<InMemoryPacketWriter>(
			  transport.ClientToServer()))
	{
		server_thread = std::thread(
			[this, mux]() { RunServer(&transport, mux); });
		recv_thread = std::thread([this]() { Receive(); });
	}

	TestCall(const TestCall &) = delete;
	TestCall &operator=(const TestCall &) = delete;

	~TestCall()
	{
		client_rpc->Close();
		InMemoryTransport::Close(transport.ServerReader());
		InMemoryTransport::Close(transport.ClientReader());
		recv_thread.join();
		server_thread.join();
	}

	/* Start starts the call, sending data first when has_data is set. */
	starpc::Error Start(bool has_data, const std::string &data)
	{
		return client_rpc->Start(writer.get(), has_data, data);
	}

	/* Rpc returns the client call. */
	starpc::ClientRPC *Rpc()
	{
		return client_rpc.get();
	}

private:
	/* Receive feeds packets to the call until the transport closes. */
	void Receive()
	{
		auto reader = transport.ClientReader();
		std::string data;
		while (InMemoryTransport::Recv(reader, &data)) {
			if (client_rpc->HandlePacketData(data) !=
			    starpc::Error::OK)
				break;
		}
		client_rpc->HandleStreamClose(starpc::Error::EOF_);
	}

	InMemoryTransport transport;
	std::unique_ptr<starpc::ClientRPC> client_rpc;
	std::unique_ptr<InMemoryPacketWriter> writer;
	std::thread server_thread;
	std::thread recv_thread;
};

/* Fail reports a failed step with its error and returns false. */
bool Fail(const std::string &step, starpc::Error err)
{
	std::cerr << "FAILED: " << step << ": " << starpc::ErrorString(err)
		  << std::endl;
	return false;
}

/* Fail reports a failed step and returns false. */
bool Fail(const std::string &step)
{
	std::cerr << "FAILED: " << step << std::endl;
	return false;
}

/* EchoRequest returns an encoded EchoMsg carrying test_body. */
std::string EchoRequest()
{
	echo::EchoMsg req;
	req.set_body(test_body);
	return req.SerializeAsString();
}

/* ReadEcho reads one EchoMsg from rpc and checks that it carries test_body. */
bool ReadEcho(starpc::ClientRPC *rpc, const std::string &step)
{
	std::string data;
	starpc::Error err = rpc->ReadOne(&data);
	if (err != starpc::Error::OK)
		return Fail(step + ": read", err);

	echo::EchoMsg resp;
	if (!resp.ParseFromString(data))
		return Fail(step + ": parse");
	if (resp.body() != test_body)
		return Fail(step + ": got '" + resp.body() + "'");
	return true;
}

/* TestUnary pins one unary request/reply round trip. */
bool TestUnary(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "Echo");
	starpc::Error err = call.Start(true, EchoRequest());
	if (err != starpc::Error::OK)
		return Fail("start", err);
	return ReadEcho(call.Rpc(), "reply");
}

/* TestServerStream pins five responses to one request. */
bool TestServerStream(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "EchoServerStream");
	starpc::Error err = call.Start(true, EchoRequest());
	if (err != starpc::Error::OK)
		return Fail("start", err);

	for (int i = 0; i < 5; i++) {
		if (!ReadEcho(call.Rpc(), "message " + std::to_string(i)))
			return false;
	}

	std::string extra;
	err = call.Rpc()->ReadOne(&extra);
	if (err != starpc::Error::EOF_)
		return Fail("end of stream", err);
	return true;
}

/* TestClientStream pins one reply to a streamed request. */
bool TestClientStream(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "EchoClientStream");
	starpc::Error err = call.Start(false, "");
	if (err != starpc::Error::OK)
		return Fail("start", err);

	err = call.Rpc()->WriteCallData(EchoRequest(), false, false,
					starpc::Error::OK);
	if (err != starpc::Error::OK)
		return Fail("send", err);
	err = call.Rpc()->WriteCallData("", false, true, starpc::Error::OK);
	if (err != starpc::Error::OK)
		return Fail("close send", err);
	return ReadEcho(call.Rpc(), "reply");
}

/* TestBidiStream pins echo replies to each sent message. */
bool TestBidiStream(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "EchoBidiStream");
	starpc::Error err = call.Start(false, "");
	if (err != starpc::Error::OK)
		return Fail("start", err);

	for (int i = 0; i < 3; i++) {
		const std::string step = "message " + std::to_string(i);
		err = call.Rpc()->WriteCallData(EchoRequest(), false, false,
						starpc::Error::OK);
		if (err != starpc::Error::OK)
			return Fail(step + ": send", err);
		if (!ReadEcho(call.Rpc(), step))
			return false;
	}

	err = call.Rpc()->WriteCallData("", false, true, starpc::Error::OK);
	if (err != starpc::Error::OK)
		return Fail("close send", err);
	return true;
}

/* TestDoNothing pins an empty request and empty reply. */
bool TestDoNothing(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "DoNothing");
	starpc::Error err =
		call.Start(true, google::protobuf::Empty().SerializeAsString());
	if (err != starpc::Error::OK)
		return Fail("start", err);

	std::string data;
	err = call.Rpc()->ReadOne(&data);
	if (err != starpc::Error::OK)
		return Fail("read", err);
	google::protobuf::Empty resp;
	if (!resp.ParseFromString(data))
		return Fail("parse");
	return true;
}

/*
 * TestRpcStream pins a nested call: the client opens an RpcStream, the server
 * answers init, and the nested Echo call returns through the nested mux.
 */
bool TestRpcStream(starpc::Mux *mux)
{
	TestCall call(mux, "echo.Echoer", "RpcStream");
	starpc::ClientRPC *rpc = call.Rpc();
	starpc::Error err = call.Start(false, "");
	if (err != starpc::Error::OK)
		return Fail("start", err);

	rpcstream::RpcStreamPacket init_pkt;
	init_pkt.mutable_init()->set_component_id("");
	err = rpc->WriteCallData(init_pkt.SerializeAsString(), false, false,
				 starpc::Error::OK);
	if (err != starpc::Error::OK)
		return Fail("send init", err);

	std::string ack_data;
	err = rpc->ReadOne(&ack_data);
	if (err != starpc::Error::OK)
		return Fail("read ack", err);
	rpcstream::RpcStreamPacket ack_pkt;
	if (!ack_pkt.ParseFromString(ack_data) || !ack_pkt.has_ack())
		return Fail("invalid ack packet");
	if (!ack_pkt.ack().error().empty())
		return Fail("ack error: " + ack_pkt.ack().error());

	/* The nested call starts inside an RpcStream data packet. */
	auto call_start = starpc::NewCallStartPacket("echo.Echoer", "Echo",
						     EchoRequest(), true);
	rpcstream::RpcStreamPacket data_pkt;
	data_pkt.set_data(call_start->SerializeAsString());
	err = rpc->WriteCallData(data_pkt.SerializeAsString(), false, false,
				 starpc::Error::OK);
	if (err != starpc::Error::OK)
		return Fail("send call start", err);

	/* The reply is an RpcStream packet holding a CallData packet. */
	std::string resp_data;
	err = rpc->ReadOne(&resp_data);
	if (err != starpc::Error::OK)
		return Fail("read reply", err);
	rpcstream::RpcStreamPacket resp_pkt;
	if (!resp_pkt.ParseFromString(resp_data) || !resp_pkt.has_data())
		return Fail("invalid reply packet");
	srpc::Packet inner_pkt;
	if (!inner_pkt.ParseFromString(resp_pkt.data()) ||
	    !inner_pkt.has_call_data())
		return Fail("invalid inner packet");
	echo::EchoMsg resp;
	if (!resp.ParseFromString(inner_pkt.call_data().data()))
		return Fail("parse reply");
	if (resp.body() != test_body)
		return Fail("got '" + resp.body() + "'");
	return true;
}

} // namespace

int main()
{
	std::cout << "=== starpc C++ E2E Tests ===" << std::endl;

	EchoServer server;
	starpc::Error err = server.Register();
	if (err != starpc::Error::OK) {
		Fail("register", err);
		return 1;
	}

	const std::pair<const char *, bool (*)(starpc::Mux *)> tests[] = {
		{"Unary", TestUnary},
		{"ServerStream", TestServerStream},
		{"ClientStream", TestClientStream},
		{"BidiStream", TestBidiStream},
		{"DoNothing", TestDoNothing},
		{"RpcStream", TestRpcStream},
	};

	int passed = 0;
	int failed = 0;
	for (const auto &[name, test] : tests) {
		std::cout << "Testing " << name << " RPC... " << std::flush;
		if (test(server.mux.get())) {
			std::cout << "PASSED" << std::endl;
			passed++;
		} else {
			failed++;
		}
	}

	std::cout << std::endl;
	std::cout << "Results: " << passed << " passed, " << failed << " failed"
		  << std::endl;
	return failed > 0 ? 1 : 0;
}
