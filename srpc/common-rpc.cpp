//go:build deps_only

#include "common-rpc.hpp"

#include "packet.hpp"
#include "rpcproto.pb.h"

namespace starpc {
namespace {

/*
 * These bounds contain an unconsumed stream, including zero-length messages.
 */
constexpr size_t maximum_queued_bytes = 4 * 1024 * 1024;
constexpr size_t maximum_queued_messages = 1024;

} // namespace

CommonRPC::CommonRPC() = default;
CommonRPC::~CommonRPC() = default;

void CommonRPC::Cancel()
{
	{
		std::lock_guard lock(state_mutex);
		canceled = true;
		local_completed = true;
		data_queue.clear();
		queued_bytes = 0;
	}
	state_changed.notify_all();
	stop_source.request_stop();
	CloseWriter();
}

bool CommonRPC::IsCanceled() const
{
	std::lock_guard lock(state_mutex);
	return canceled;
}

std::string CommonRPC::RemoteErrorMessage() const
{
	std::lock_guard lock(state_mutex);
	return remote_error_message;
}

Error CommonRPC::ReadOne(std::string *out)
{
	auto readable = [this] {
		return canceled || data_closed || !data_queue.empty();
	};

	/* Wait for a message, the call's end, or cancellation. */
	std::unique_lock lock(state_mutex);
	state_changed.wait(lock, readable);

	if (canceled)
		return remote_error != Error::OK ? remote_error
						 : Error::Canceled;
	if (!data_queue.empty()) {
		*out = std::move(data_queue.front());
		queued_bytes -= out->size();
		data_queue.pop_front();
		return Error::OK;
	}
	return remote_error != Error::OK ? remote_error : Error::EOF_;
}

Error CommonRPC::WriteCallData(const std::string &data, bool data_is_zero,
			       bool complete, Error err)
{
	std::unique_lock writing(write_mutex);
	PacketWriter *w;
	{
		std::lock_guard lock(state_mutex);
		if (canceled)
			return Error::Canceled;
		if (local_completed) {
			return complete && data.empty() && !data_is_zero
				       ? Error::OK
				       : Error::Completed;
		}
		if (writer == nullptr)
			return Error::NilWriter;
		if (writer_closed)
			return Error::Completed;
		if (complete || err != Error::OK)
			local_completed = true;
		w = writer;
	}

	const auto packet = NewCallDataPacket(
		data, data.empty() && data_is_zero, complete, err);
	const auto written = w->WritePacket(*packet);
	writing.unlock();

	/*
	 * A failed half-close leaves the verdict to the transport close, which
	 * follows any reply and completion the transport read but has not
	 * delivered.
	 */
	const bool half_close =
		complete && data.empty() && !data_is_zero && err == Error::OK;
	if (written != Error::OK && !half_close)
		HandleStreamClose(written);
	return written;
}

void CommonRPC::HandleStreamClose(Error close_err)
{
	{
		std::lock_guard lock(state_mutex);
		if (canceled)
			return;
		if (close_err == Error::EOF_)
			close_err = Error::OK;
		if (remote_error == Error::OK && close_err != Error::OK)
			remote_error = close_err;
		if (remote_error == Error::OK && !remote_completed &&
		    !local_completing)
			remote_error = Error::ClosedBeforeCompletion;
		data_closed = true;
	}
	state_changed.notify_all();
	stop_source.request_stop();
	CloseWriter();
}

Error CommonRPC::HandleCallCancel()
{
	Cancel();
	return Error::OK;
}

Error CommonRPC::HandleCallData(const srpc::CallData &pkt)
{
	bool overflow = false;
	{
		std::lock_guard lock(state_mutex);
		if (canceled)
			return Error::Canceled;
		if (data_closed)
			return pkt.complete() ? Error::OK : Error::Completed;
		if (!pkt.data().empty() || pkt.data_is_zero()) {
			overflow =
				data_queue.size() >= maximum_queued_messages ||
				pkt.data().size() >
					maximum_queued_bytes - queued_bytes;
			if (!overflow) {
				data_queue.push_back(pkt.data());
				queued_bytes += pkt.data().size();
			}
		}
		if (!pkt.error().empty()) {
			remote_error = Error::RemoteError;
			remote_error_message = pkt.error();
		}
		if (pkt.complete() || remote_error != Error::OK) {
			data_closed = true;
			remote_completed = true;
		}
	}

	/* Close the transport before reporting an overflowing queue. */
	if (overflow) {
		HandleStreamClose(Error::ResourceExhausted);
		return Error::ResourceExhausted;
	}
	state_changed.notify_all();
	return Error::OK;
}

Error CommonRPC::WriteCallCancel()
{
	std::unique_lock writing(write_mutex);
	PacketWriter *w;
	{
		std::lock_guard lock(state_mutex);
		if (canceled || writer_closed)
			return Error::Canceled;
		if (local_completed)
			return Error::Completed;
		if (writer == nullptr)
			return Error::NilWriter;
		local_completed = true;
		w = writer;
	}

	const auto written = w->WritePacket(*NewCallCancelPacket());
	writing.unlock();
	if (written != Error::OK)
		HandleStreamClose(written);
	return written;
}

void CommonRPC::CloseWriter()
{
	PacketWriter *w;
	{
		std::lock_guard lock(state_mutex);
		if (writer_closed || writer == nullptr)
			return;
		writer_closed = true;
		w = writer;
	}
	(void)w->Close();
}

void CommonRPC::Finish(Error err)
{
	{
		std::lock_guard lock(state_mutex);
		local_completing = true;
	}

	(void)WriteCallData("", false, true, err);
	CloseWriter();
	stop_source.request_stop();
}

} // namespace starpc
