#pragma once

#include "errors.hpp"
#include "message.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <stop_token>
#include <string>

namespace starpc {

/*
 * Stream is one live RPC stream between the caller and the remote. Matches
 * the Go Stream interface in stream.go.
 */
class Stream {
public:
	virtual ~Stream() = default;

	/* StopToken interrupts work when the RPC ends or is canceled. */
	virtual std::stop_token StopToken() const
	{
		return {};
	}

	/*
	 * RemoteErrorMessage returns the diagnostic accompanying
	 * Error::RemoteError.
	 */
	virtual std::string RemoteErrorMessage() const
	{
		return {};
	}

	/* MsgSend serializes msg and writes it to the remote. */
	virtual Error MsgSend(const Message &msg) = 0;

	/*
	 * MsgRecv reads the next message from the remote and parses it into
	 * msg. Returns EOF_ after the call completes.
	 */
	virtual Error MsgRecv(Message *msg) = 0;

	/*
	 * CloseSend half-closes: no further messages will be sent. Once the
	 * request is written, the half-close is only a notice: it fails when
	 * the call already ended, and MsgRecv then returns the buffered
	 * messages followed by the call's outcome.
	 */
	virtual Error CloseSend() = 0;

	/* Close ends the stream for both reading and writing. */
	virtual Error Close() = 0;
};

/*
 * StreamWithClose forwards a Stream and runs an extra callback on the first
 * Close. Matches streamWithClose in stream.go.
 */
class StreamWithClose : public Stream {
public:
	/*
	 * StreamWithClose borrows inner; it must outlive the wrapper.
	 * close_fn runs once, after inner->Close.
	 */
	StreamWithClose(Stream *inner, std::function<Error()> close_fn)
		: inner(inner),
		  close_fn(std::move(close_fn))
	{
	}

	Error MsgSend(const Message &msg) override
	{
		return inner->MsgSend(msg);
	}
	Error MsgRecv(Message *msg) override
	{
		return inner->MsgRecv(msg);
	}
	Error CloseSend() override
	{
		return inner->CloseSend();
	}
	std::stop_token StopToken() const override
	{
		return inner->StopToken();
	}
	std::string RemoteErrorMessage() const override
	{
		return inner->RemoteErrorMessage();
	}

	Error Close() override
	{
		if (closed.exchange(true))
			return Error::OK;

		/* Report the inner close even when the callback also fails. */
		Error err = inner->Close();
		Error err2 = close_fn();
		if (err != Error::OK)
			return err;
		return err2;
	}

private:
	/* inner is borrowed; the caller owns it. */
	Stream *inner;
	std::function<Error()> close_fn;
	std::atomic<bool> closed{false};
};

/* NewStreamWithClose wraps strm so close_fn runs on the first Close. */
inline std::unique_ptr<Stream>
NewStreamWithClose(Stream *strm, std::function<Error()> close_fn)
{
	return std::make_unique<StreamWithClose>(strm, std::move(close_fn));
}

} // namespace starpc
