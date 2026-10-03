#pragma once

#include <stdexcept>
#include <string>

namespace starpc {

/*
 * Error is the house error value. Every action returns one; OK is success.
 * The codes mirror the Go starpc errors in errors.go; ErrorString holds each
 * diagnostic text.
 */
enum class Error {
	OK = 0,
	Unimplemented, /* the RPC method was not implemented */
	Completed,     /* unexpected packet after the RPC completed */
	UnrecognizedPacket,
	EmptyPacket,
	InvalidMessage, /* the message failed to parse */
	EmptyMethodID,
	EmptyServiceID,
	NoAvailableClients,
	NilWriter,
	Canceled, /* context.Canceled equivalent */
	EOF_,	  /* io.EOF equivalent; named EOF_ to avoid the macro */
	Reset,	  /* the forwarded transport was reset */
	ClosedBeforeCompletion, /* the transport ended without a verdict */
	ResourceExhausted, /* the receive queue or thread capacity was hit */
	RemoteError, /* RemoteErrorMessage retains the peer's diagnostic */
};

/* ErrorString returns the stable diagnostic text for err. */
inline const char *ErrorString(Error err)
{
	switch (err) {
	case Error::OK:
		return "ok";
	case Error::Unimplemented:
		return "unimplemented";
	case Error::Completed:
		return "unexpected packet after rpc was completed";
	case Error::UnrecognizedPacket:
		return "unrecognized packet type";
	case Error::EmptyPacket:
		return "invalid empty packet";
	case Error::InvalidMessage:
		return "invalid message";
	case Error::EmptyMethodID:
		return "method id empty";
	case Error::EmptyServiceID:
		return "service id empty";
	case Error::NoAvailableClients:
		return "no available rpc clients";
	case Error::NilWriter:
		return "writer cannot be nil";
	case Error::Canceled:
		return "canceled";
	case Error::EOF_:
		return "EOF";
	case Error::Reset:
		return "stream reset";
	case Error::ClosedBeforeCompletion:
		return "stream closed before the remote reported completion";
	case Error::ResourceExhausted:
		return "RPC resource limit exceeded";
	case Error::RemoteError:
		return "remote RPC error";
	default:
		return "unknown error";
	}
}

/*
 * StarpcError carries an Error across a throwing boundary. Exceptions are
 * disabled in the house build; this exists only for embedders that enable
 * them.
 */
class StarpcError : public std::runtime_error {
public:
	explicit StarpcError(Error code)
		: std::runtime_error(ErrorString(code)),
		  code_(code)
	{
	}

	/* StarpcError reports message as the diagnostic for code. */
	StarpcError(Error code, const std::string &message)
		: std::runtime_error(message),
		  code_(code)
	{
	}

	/* code returns the Error this exception carries. */
	Error code() const noexcept
	{
		return code_;
	}

private:
	/* code_ keeps the Error; the getter takes the API name code(). */
	Error code_;
};

} // namespace starpc
