#pragma once

#include "errors.hpp"
#include "message.hpp"
#include "stream.hpp"

#include <atomic>
#include <functional>
#include <string>

namespace starpc {

/*
 * MsgStreamRw is the call-state side of MsgStream: it reads and writes one
 * call's messages. Matches the Go msgStreamRw interface.
 */
class MsgStreamRw {
public:
	virtual ~MsgStreamRw() = default;

	/* RemoteErrorMessage returns the peer's retained diagnostic, if any. */
	virtual std::string RemoteErrorMessage() const
	{
		return {};
	}

	/*
	 * ReadOne returns the next message in out. Returns EOF_ after the
	 * call completes and Canceled after local cancellation.
	 */
	virtual Error ReadOne(std::string *out) = 0;

	/*
	 * WriteCallData writes one data packet. data_is_zero marks an
	 * intentionally empty message; complete ends the sending side; err
	 * carries the terminal verdict.
	 */
	virtual Error WriteCallData(const std::string &data, bool data_is_zero,
				    bool complete, Error err) = 0;

	/* WriteCallCancel cancels the call on the remote. */
	virtual Error WriteCallCancel() = 0;
};

/*
 * MsgStream is the Stream handed to handlers: it serializes messages over a
 * MsgStreamRw and closes the call when the handler is done.
 */
class MsgStream : public Stream {
public:
	/*
	 * MsgStream borrows rw; it must outlive the stream. close_cb, when
	 * set, replaces the cancel write on Close; stop carries the call's
	 * cancellation to the handler.
	 */
	MsgStream(MsgStreamRw *rw, std::function<void()> close_cb,
		  std::stop_token stop = {})
		: rw(rw),
		  close_cb(std::move(close_cb)),
		  stop(stop)
	{
	}

	std::stop_token StopToken() const override
	{
		return stop;
	}
	std::string RemoteErrorMessage() const override
	{
		return rw->RemoteErrorMessage();
	}

	Error MsgSend(const Message &msg) override
	{
		std::string msg_data;
		if (!msg.SerializeToString(&msg_data))
			return Error::InvalidMessage;
		return rw->WriteCallData(msg_data, msg_data.empty(), false,
					 Error::OK);
	}

	Error MsgRecv(Message *msg) override
	{
		std::string data;
		Error err = rw->ReadOne(&data);
		if (err != Error::OK)
			return err;
		if (!msg->ParseFromString(data))
			return Error::InvalidMessage;
		return Error::OK;
	}

	/*
	 * CloseSend half-closes the sending side. See Stream::CloseSend for
	 * why its failure leaves the outcome to MsgRecv.
	 */
	Error CloseSend() override
	{
		return rw->WriteCallData("", false, true, Error::OK);
	}

	/*
	 * Close ends the call once: through close_cb when the call is shared
	 * with a transport, otherwise by writing cancel to the remote.
	 */
	Error Close() override
	{
		if (closed.exchange(true))
			return Error::OK;
		if (close_cb) {
			close_cb();
			return Error::OK;
		}
		return rw->WriteCallCancel();
	}

private:
	/* rw is borrowed; the caller owns it. */
	MsgStreamRw *rw;
	std::function<void()> close_cb;
	std::stop_token stop;
	std::atomic<bool> closed{false};
};

/* NewMsgStream constructs a Stream over rw. */
inline std::unique_ptr<MsgStream> NewMsgStream(MsgStreamRw *rw,
					       std::function<void()> close_cb,
					       std::stop_token stop = {})
{
	return std::make_unique<MsgStream>(rw, std::move(close_cb), stop);
}

} // namespace starpc
