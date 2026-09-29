//go:build deps_only

/*
 * C++ TCP integration client for cross-language testing: it connects to a
 * TCP server and runs the echo test suite over length-prefixed packets.
 */

#include "echo/echo_srpc.pb.hpp"
#include "srpc/rpcproto.pb.h"
#include "srpc/starpc.hpp"

#include <arpa/inet.h>
#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <mutex>
#include <netinet/in.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

namespace {

const char *test_body = "hello world via starpc cross-language e2e test";

/* ReadFull reads exactly n bytes from fd, reporting short reads as false. */
bool ReadFull(int fd, void *buf, size_t n)
{
	size_t total = 0;
	while (total < n) {
		ssize_t r =
			read(fd, static_cast<char *>(buf) + total, n - total);
		if (r <= 0)
			return false;
		total += r;
	}
	return true;
}

/* WriteFull writes exactly n bytes to fd, reporting short writes as false. */
bool WriteFull(int fd, const void *buf, size_t n)
{
	size_t total = 0;
	while (total < n) {
		ssize_t w = write(fd, static_cast<const char *>(buf) + total,
				  n - total);
		if (w <= 0)
			return false;
		total += w;
	}
	return true;
}

/*
 * TcpPacketWriter writes length-prefixed packets to a TCP socket. The fd is
 * borrowed and closed by the test, not the writer.
 */
class TcpPacketWriter : public starpc::PacketWriter {
public:
	explicit TcpPacketWriter(int fd)
		: fd(fd)
	{
	}

	starpc::Error WritePacket(const srpc::Packet &pkt) override
	{
		std::lock_guard<std::mutex> lock(mu);

		std::string data;
		if (!pkt.SerializeToString(&data))
			return starpc::Error::InvalidMessage;

		/* The length prefix is a little-endian uint32. */
		uint32_t len = static_cast<uint32_t>(data.size());
		if (!WriteFull(fd, &len, 4))
			return starpc::Error::EOF_;
		if (!WriteFull(fd, data.data(), data.size()))
			return starpc::Error::EOF_;
		return starpc::Error::OK;
	}

	starpc::Error Close() override
	{
		shutdown(fd, SHUT_WR);
		return starpc::Error::OK;
	}

private:
	int fd;
	std::mutex mu;
};

/* TcpConnect opens a connection to host:port, or -1 on failure. */
int TcpConnect(const std::string &host, int port)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0)
		return -1;

	struct sockaddr_in addr{};
	addr.sin_family = AF_INET;
	addr.sin_port = htons(port);
	inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

	if (connect(fd, reinterpret_cast<struct sockaddr *>(&addr),
		    sizeof(addr)) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

/*
 * ReadPacketLoop reads length-prefixed packets and feeds them to rpc until
 * done is set, the socket ends, or the call fails.
 */
void ReadPacketLoop(int fd, starpc::ClientRPC *rpc, std::atomic<bool> *done)
{
	while (!done->load()) {
		uint32_t len = 0;
		if (!ReadFull(fd, &len, 4)) {
			rpc->HandleStreamClose(starpc::Error::EOF_);
			break;
		}
		std::string data(len, '\0');
		if (!ReadFull(fd, data.data(), len)) {
			rpc->HandleStreamClose(starpc::Error::EOF_);
			break;
		}
		starpc::Error err = rpc->HandlePacketData(data);
		if (err != starpc::Error::OK)
			break;
	}
}

/*
 * CleanupConn shuts the socket down, joins the reader thread, then closes
 * the fd. The join order avoids an fd reuse race with the reader.
 */
void CleanupConn(int fd, std::atomic<bool> &done, std::thread &reader)
{
	done.store(true);
	shutdown(fd, SHUT_RDWR);
	reader.join();
	close(fd);
}

/* ParseAddr splits "host:port" into host and port. */
bool ParseAddr(const std::string &addr, std::string *host, int *port)
{
	auto pos = addr.rfind(':');
	if (pos == std::string::npos)
		return false;
	*host = addr.substr(0, pos);
	*port = std::stoi(addr.substr(pos + 1));
	return true;
}

/* TestUnary pins one unary request/reply over TCP. */
bool TestUnary(const std::string &host, int port)
{
	std::cout << "Testing Unary RPC... " << std::flush;

	int fd = TcpConnect(host, port);
	if (fd < 0) {
		std::cerr << "FAILED: connect" << std::endl;
		return false;
	}

	auto rpc = starpc::NewClientRPC("echo.Echoer", "Echo");
	auto writer = std::make_unique<TcpPacketWriter>(fd);

	std::atomic<bool> done{false};
	std::thread reader(ReadPacketLoop, fd, rpc.get(), &done);

	echo::EchoMsg req;
	req.set_body(test_body);
	std::string req_data;
	req.SerializeToString(&req_data);

	starpc::Error err = rpc->Start(writer.get(), true, req_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: start: " << starpc::ErrorString(err)
			  << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	std::string resp_data;
	err = rpc->ReadOne(&resp_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: read: " << starpc::ErrorString(err)
			  << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	echo::EchoMsg resp;
	if (!resp.ParseFromString(resp_data) || resp.body() != test_body) {
		std::cerr << "FAILED: body mismatch" << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	rpc->Close();
	CleanupConn(fd, done, reader);

	std::cout << "PASSED" << std::endl;
	return true;
}

/* TestServerStream pins five streamed responses over TCP. */
bool TestServerStream(const std::string &host, int port)
{
	std::cout << "Testing ServerStream RPC... " << std::flush;

	int fd = TcpConnect(host, port);
	if (fd < 0) {
		std::cerr << "FAILED: connect" << std::endl;
		return false;
	}

	auto rpc = starpc::NewClientRPC("echo.Echoer", "EchoServerStream");
	auto writer = std::make_unique<TcpPacketWriter>(fd);

	std::atomic<bool> done{false};
	std::thread reader(ReadPacketLoop, fd, rpc.get(), &done);

	echo::EchoMsg req;
	req.set_body(test_body);
	std::string req_data;
	req.SerializeToString(&req_data);

	starpc::Error err = rpc->Start(writer.get(), true, req_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: start" << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	int received = 0;
	for (int i = 0; i < 5; i++) {
		std::string resp_data;
		err = rpc->ReadOne(&resp_data);
		if (err != starpc::Error::OK) {
			std::cerr << "FAILED: read " << i << ": "
				  << starpc::ErrorString(err) << std::endl;
			rpc->Close();
			CleanupConn(fd, done, reader);
			return false;
		}
		echo::EchoMsg resp;
		if (!resp.ParseFromString(resp_data) ||
		    resp.body() != test_body) {
			std::cerr << "FAILED: body mismatch at " << i
				  << std::endl;
			rpc->Close();
			CleanupConn(fd, done, reader);
			return false;
		}
		received++;
	}

	rpc->Close();
	CleanupConn(fd, done, reader);

	if (received != 5) {
		std::cerr << "FAILED: expected 5, got " << received
			  << std::endl;
		return false;
	}

	std::cout << "PASSED" << std::endl;
	return true;
}

/* TestClientStream pins one reply to a streamed request over TCP. */
bool TestClientStream(const std::string &host, int port)
{
	std::cout << "Testing ClientStream RPC... " << std::flush;

	int fd = TcpConnect(host, port);
	if (fd < 0) {
		std::cerr << "FAILED: connect" << std::endl;
		return false;
	}

	auto rpc = starpc::NewClientRPC("echo.Echoer", "EchoClientStream");
	auto writer = std::make_unique<TcpPacketWriter>(fd);

	std::atomic<bool> done{false};
	std::thread reader(ReadPacketLoop, fd, rpc.get(), &done);

	starpc::Error err = rpc->Start(writer.get(), false, "");
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: start" << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	echo::EchoMsg req;
	req.set_body(test_body);
	std::string req_data;
	req.SerializeToString(&req_data);

	err = rpc->WriteCallData(req_data, false, false, starpc::Error::OK);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: write" << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	err = rpc->WriteCallData("", false, true, starpc::Error::OK);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: close send" << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	std::string resp_data;
	err = rpc->ReadOne(&resp_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: read: " << starpc::ErrorString(err)
			  << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	echo::EchoMsg resp;
	if (!resp.ParseFromString(resp_data) || resp.body() != test_body) {
		std::cerr << "FAILED: body mismatch" << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	rpc->Close();
	CleanupConn(fd, done, reader);

	std::cout << "PASSED" << std::endl;
	return true;
}

/* TestBidiStream pins echo replies to each sent message over TCP. */
bool TestBidiStream(const std::string &host, int port)
{
	std::cout << "Testing BidiStream RPC... " << std::flush;

	int fd = TcpConnect(host, port);
	if (fd < 0) {
		std::cerr << "FAILED: connect" << std::endl;
		return false;
	}

	auto rpc = starpc::NewClientRPC("echo.Echoer", "EchoBidiStream");
	auto writer = std::make_unique<TcpPacketWriter>(fd);

	std::atomic<bool> done{false};
	std::thread reader(ReadPacketLoop, fd, rpc.get(), &done);

	starpc::Error err = rpc->Start(writer.get(), false, "");
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: start" << std::endl;
		CleanupConn(fd, done, reader);
		return false;
	}

	/* Receive initial "hello from server" message. */
	std::string init_data;
	err = rpc->ReadOne(&init_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: read init: " << starpc::ErrorString(err)
			  << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}
	echo::EchoMsg init_msg;
	if (!init_msg.ParseFromString(init_data) ||
	    init_msg.body() != "hello from server") {
		std::cerr << "FAILED: init body mismatch: '" << init_msg.body()
			  << "'" << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	/* Send a message and expect echo. */
	echo::EchoMsg req;
	req.set_body(test_body);
	std::string req_data;
	req.SerializeToString(&req_data);

	err = rpc->WriteCallData(req_data, false, false, starpc::Error::OK);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: write" << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	std::string resp_data;
	err = rpc->ReadOne(&resp_data);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: read echo: " << starpc::ErrorString(err)
			  << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	echo::EchoMsg resp;
	if (!resp.ParseFromString(resp_data) || resp.body() != test_body) {
		std::cerr << "FAILED: echo body mismatch" << std::endl;
		rpc->Close();
		CleanupConn(fd, done, reader);
		return false;
	}

	/* Close send. */
	err = rpc->WriteCallData("", false, true, starpc::Error::OK);
	if (err != starpc::Error::OK) {
		std::cerr << "FAILED: close send" << std::endl;
	}

	rpc->Close();
	CleanupConn(fd, done, reader);

	std::cout << "PASSED" << std::endl;
	return true;
}

} // namespace

int main(int argc, char *argv[])
{
	/*
	 * Ignore SIGPIPE so writing to a closed socket returns EPIPE instead
	 * of killing the process: the server may close its side before the
	 * cleanup packets are sent.
	 */
	signal(SIGPIPE, SIG_IGN);

	if (argc < 2) {
		std::cerr << "usage: cpp-client <host:port>" << std::endl;
		return 1;
	}

	std::string host;
	int port;
	if (!ParseAddr(argv[1], &host, &port)) {
		std::cerr << "invalid address: " << argv[1] << std::endl;
		return 1;
	}

	std::cout << "=== starpc C++ Cross-Language Client ===" << std::endl;

	int passed = 0, failed = 0;

	if (TestUnary(host, port))
		passed++;
	else
		failed++;
	if (TestServerStream(host, port))
		passed++;
	else
		failed++;
	if (TestClientStream(host, port))
		passed++;
	else
		failed++;
	if (TestBidiStream(host, port))
		passed++;
	else
		failed++;

	std::cout << std::endl
		  << "Results: " << passed << " passed, " << failed << " failed"
		  << std::endl;

	if (failed > 0) {
		std::cout << "FAILED" << std::endl;
		return 1;
	}
	std::cout << "All tests passed." << std::endl;
	return 0;
}
