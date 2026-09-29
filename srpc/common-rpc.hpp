#pragma once

#include "errors.hpp"
#include "writer.hpp"

#include <condition_variable>
#include <deque>
#include <mutex>
#include <stop_token>
#include <string>

namespace srpc {
class CallData;
}

namespace starpc {

/*
 * CommonRPC holds the state one call shares between its transport side and
 * its handler side: message delivery, half-close, and cancellation. The
 * packet writer must outlive the call and interrupt blocked writes when
 * closed. Subclasses drive it through Handle* from the transport and
 * ReadOne/WriteCallData from the handler.
 */
class CommonRPC {
public:
	CommonRPC();
	virtual ~CommonRPC();

	/* Cancel interrupts reads and writes. Repeating it is safe. */
	void Cancel();

	/* IsCanceled reports whether Cancel or a peer cancel has run. */
	bool IsCanceled() const;

	/*
	 * StopToken lets handlers cancel work outside ReadOne when the call
	 * ends.
	 */
	std::stop_token StopToken() const
	{
		return stop_source.get_token();
	}

	/* GetService and GetMethod stay stable after call startup. */
	const std::string &GetService() const
	{
		return service;
	}
	const std::string &GetMethod() const
	{
		return method;
	}

	/*
	 * RemoteErrorMessage retains the peer's diagnostic when ReadOne
	 * returns RemoteError.
	 */
	std::string RemoteErrorMessage() const;

	/*
	 * ReadOne returns the next queued message in out. It returns EOF_
	 * after a normal completion, the peer's error for a failed call, and
	 * Canceled after local cancellation; an abrupt peer disconnect is not
	 * a successful EOF.
	 */
	Error ReadOne(std::string *out);

	/*
	 * WriteCallData writes one data packet. data_is_zero marks an
	 * intentionally empty message; complete ends the sending side; err
	 * carries the terminal verdict. A failed write ends the call, except
	 * for a bare half-close, whose outcome the transport close settles.
	 */
	Error WriteCallData(const std::string &data, bool data_is_zero,
			    bool complete, Error err);

	/*
	 * HandleStreamClose records the transport ending. EOF_ means the peer
	 * half-closed cleanly; any other error becomes the call's verdict when
	 * the peer has not given one.
	 */
	void HandleStreamClose(Error close_err);

	/* HandleCallCancel honors the peer's cancel packet. */
	Error HandleCallCancel();

	/* HandleCallData queues one data packet and applies its verdict. */
	Error HandleCallData(const srpc::CallData &pkt);

	/* WriteCallCancel writes cancel to the remote and ends the call. */
	Error WriteCallCancel();

protected:
	/* Finish publishes err as the call's verdict and closes the writer. */
	void Finish(Error err);

	/* CloseWriter closes the transport once per call, outside the locks. */
	void CloseWriter();

	/*
	 * state_mutex guards the call state below. write_mutex orders outgoing
	 * packets and may precede state_mutex; transport close never waits for
	 * write_mutex.
	 */
	mutable std::mutex state_mutex;
	std::mutex write_mutex;
	std::condition_variable state_changed;

	std::string service;
	std::string method;

	/* writer is borrowed until the call and transport callbacks stop. */
	PacketWriter *writer = nullptr;
	bool writer_closed = false;

	/* local_completed is set once the handler side has sent its verdict. */
	bool local_completed = false;
	bool local_completing = false;
	bool canceled = false;

	/* data_closed ends the receive side; remote_completed records why. */
	bool data_closed = false;
	bool remote_completed = false;
	Error remote_error = Error::OK;
	std::string remote_error_message;

	/*
	 * data_queue holds messages received before their reader ran, bounded
	 * by queued_bytes and the queue length.
	 */
	std::deque<std::string> data_queue;
	size_t queued_bytes = 0;

	/* stop_source drives StopToken; cancellation and close request it. */
	std::stop_source stop_source;
};

} // namespace starpc
