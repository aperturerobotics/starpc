#pragma once

#include <string>
#include <vector>

#include "invoker.hpp"

namespace starpc {

// Handler describes a SRPC call handler implementation.
// Matches Go Handler interface in handler.go
class Handler : public Invoker {
 public:
  ~Handler() override = default;

  // GetServiceID returns the ID of the service.
  virtual const std::string& GetServiceID() const = 0;

  // GetMethodIDs returns the list of methods for the service.
  virtual std::vector<std::string> GetMethodIDs() const = 0;
};

}  // namespace starpc
