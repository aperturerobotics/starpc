#pragma once

#include "errors.hpp"
#include "handler.hpp"
#include "invoker.hpp"

#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace starpc {

/*
 * Mux dispatches calls to registered handlers and falls back to a list of
 * invokers when no handler matches. Matches the Go Mux in mux.go.
 */
class Mux : public Invoker, public QueryableInvoker {
public:
	/*
	 * Mux consults fallback_invokers, in order, when no registered
	 * handler matches. The invokers are borrowed and must outlive the
	 * mux.
	 */
	explicit Mux(std::vector<Invoker *> fallback_invokers = {});
	~Mux() override = default;

	/*
	 * Register maps the handler's service and method IDs to it. An empty
	 * service ID fails; empty method IDs are skipped.
	 */
	Error Register(Handler *handler);

	/*
	 * InvokeMethod runs the registered handler for the IDs and reports
	 * whether it found one. An empty service_id searches every service.
	 * Unhandled calls go to the fallback invokers.
	 */
	std::pair<bool, Error> InvokeMethod(const std::string &service_id,
					    const std::string &method_id,
					    Stream *strm) override;

	/* HasService reports whether any handler registered service_id. */
	bool HasService(const std::string &service_id) const override;

	/*
	 * HasServiceMethod reports whether a registered handler for
	 * service_id serves method_id.
	 */
	bool HasServiceMethod(const std::string &service_id,
			      const std::string &method_id) const override;

private:
	/* methods maps one method ID to the handler that registered it. */
	using methods = std::unordered_map<std::string, Handler *>;

	/* fallback invokers are borrowed; the caller owns them. */
	std::vector<Invoker *> fallback;

	/* mu guards services. */
	mutable std::shared_mutex mu;

	/* services maps each service ID to its method table. */
	std::unordered_map<std::string, methods> services;
};

/* NewMux constructs a Mux with the given fallback invokers. */
inline std::unique_ptr<Mux>
NewMux(std::vector<Invoker *> fallback_invokers = {})
{
	return std::make_unique<Mux>(std::move(fallback_invokers));
}

} // namespace starpc
