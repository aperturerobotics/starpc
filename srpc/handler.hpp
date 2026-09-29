#pragma once

#include <string>
#include <vector>

#include "invoker.hpp"

namespace starpc {

/*
 * Handler is one registered SRPC service: an Invoker that publishes its
 * service ID and method list. Matches the Go Handler interface in handler.go.
 */
class Handler : public Invoker {
public:
	~Handler() override = default;

	/* GetServiceID returns the service this handler registers. */
	virtual const std::string &GetServiceID() const = 0;

	/* GetMethodIDs returns every method the service answers. */
	virtual std::vector<std::string> GetMethodIDs() const = 0;
};

} // namespace starpc
