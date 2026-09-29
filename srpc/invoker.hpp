#pragma once

#include <string>
#include <utility>
#include <vector>

#include "errors.hpp"
#include "stream.hpp"

namespace starpc {

/*
 * Invoker dispatches one SRPC method call. Matches the Go Invoker interface
 * in invoker.go.
 */
class Invoker {
public:
	virtual ~Invoker() = default;

	/*
	 * InvokeMethod runs the handler for service_id and method_id and
	 * reports whether it found one. An empty service_id matches any
	 * service. found is false only when no handler applies; strm carries
	 * the call.
	 */
	virtual std::pair<bool, Error>
	InvokeMethod(const std::string &service_id,
		     const std::string &method_id, Stream *strm) = 0;
};

/*
 * QueryableInvoker answers whether it implements a service or method without
 * running one. Matches the Go QueryableInvoker interface in invoker.go.
 */
class QueryableInvoker {
public:
	virtual ~QueryableInvoker() = default;

	/* HasService reports whether service_id is registered. */
	virtual bool HasService(const std::string &service_id) const = 0;

	/* HasServiceMethod reports whether the service serves method_id. */
	virtual bool HasServiceMethod(const std::string &service_id,
				      const std::string &method_id) const = 0;
};

/*
 * InvokerSlice tries each invoker in order and stops at the first that
 * handles the call or fails. The invokers are borrowed and must outlive the
 * slice. Matches Go InvokerSlice in invoker.go.
 */
class InvokerSlice : public Invoker {
public:
	InvokerSlice() = default;
	explicit InvokerSlice(std::vector<Invoker *> invokers)
		: invokers(std::move(invokers))
	{
	}

	/* Add appends an invoker to try after the ones already present. */
	void Add(Invoker *invoker)
	{
		invokers.push_back(invoker);
	}

	std::pair<bool, Error> InvokeMethod(const std::string &service_id,
					    const std::string &method_id,
					    Stream *strm) override
	{
		for (auto *invoker : invokers) {
			if (invoker == nullptr)
				continue;
			auto [found, err] = invoker->InvokeMethod(
				service_id, method_id, strm);
			if (found || err != Error::OK)
				return {true, err};
		}
		return {false, Error::OK};
	}

private:
	/* invokers are borrowed; the caller owns them. */
	std::vector<Invoker *> invokers;
};

/*
 * InvokerFunc is the callable form of Invoker::InvokeMethod. Matches Go
 * InvokerFunc in invoker.go.
 */
using InvokerFunc = std::function<std::pair<bool, Error>(
	const std::string &service_id, const std::string &method_id,
	Stream *strm)>;

/*
 * InvokerFuncWrapper adapts an InvokerFunc to the Invoker interface. An empty
 * function reports that no handler applies.
 */
class InvokerFuncWrapper : public Invoker {
public:
	explicit InvokerFuncWrapper(InvokerFunc fn)
		: fn(std::move(fn))
	{
	}

	std::pair<bool, Error> InvokeMethod(const std::string &service_id,
					    const std::string &method_id,
					    Stream *strm) override
	{
		if (!fn)
			return {false, Error::OK};
		return fn(service_id, method_id, strm);
	}

private:
	InvokerFunc fn;
};

} // namespace starpc
