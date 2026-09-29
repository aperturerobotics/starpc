//go:build deps_only

#include "mux.hpp"

#include <shared_mutex>

namespace starpc {

Mux::Mux(std::vector<Invoker *> fallback_invokers)
	: fallback(std::move(fallback_invokers))
{
}

Error Mux::Register(Handler *handler)
{
	const std::string &service_id = handler->GetServiceID();
	auto method_ids = handler->GetMethodIDs();

	if (service_id.empty())
		return Error::EmptyServiceID;

	std::unique_lock<std::shared_mutex> lock(mu);

	auto &service_methods = services[service_id];
	for (const auto &method_id : method_ids) {
		if (!method_id.empty())
			service_methods[method_id] = handler;
	}

	return Error::OK;
}

bool Mux::HasService(const std::string &service_id) const
{
	if (service_id.empty())
		return false;

	std::shared_lock<std::shared_mutex> lock(mu);
	auto it = services.find(service_id);
	return it != services.end() && !it->second.empty();
}

bool Mux::HasServiceMethod(const std::string &service_id,
			   const std::string &method_id) const
{
	if (service_id.empty() || method_id.empty())
		return false;

	std::shared_lock<std::shared_mutex> lock(mu);
	auto svc_it = services.find(service_id);
	if (svc_it == services.end())
		return false;

	for (const auto &[mid, handler] : svc_it->second) {
		for (const auto &handler_method : handler->GetMethodIDs()) {
			if (handler_method == method_id)
				return true;
		}
	}

	return false;
}

std::pair<bool, Error> Mux::InvokeMethod(const std::string &service_id,
					 const std::string &method_id,
					 Stream *strm)
{
	Handler *handler = nullptr;

	/* Find the registered handler outside any handler call. */
	{
		std::shared_lock<std::shared_mutex> lock(mu);

		if (service_id.empty()) {
			for (const auto &[svc_id, svc_methods] : services) {
				auto it = svc_methods.find(method_id);
				if (it != svc_methods.end()) {
					handler = it->second;
					break;
				}
			}
		} else {
			auto svc_it = services.find(service_id);
			if (svc_it != services.end()) {
				auto method_it = svc_it->second.find(method_id);
				if (method_it != svc_it->second.end())
					handler = method_it->second;
			}
		}
	}

	if (handler != nullptr)
		return handler->InvokeMethod(service_id, method_id, strm);

	/* Try each fallback invoker in order. */
	for (auto *invoker : fallback) {
		if (invoker == nullptr)
			continue;
		auto [handled, err] = invoker->InvokeMethod(service_id,
							    method_id, strm);
		if (err != Error::OK || handled)
			return {handled, err};
	}

	return {false, Error::OK};
}

} // namespace starpc
