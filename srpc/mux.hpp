#pragma once

#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "errors.hpp"
#include "handler.hpp"
#include "invoker.hpp"

namespace starpc {

// Mux contains a set of <service, method> handlers.
// Matches Go Mux interface in mux.go
class Mux : public Invoker, public QueryableInvoker {
 public:
  // Constructor matching NewMux in Go
  explicit Mux(std::vector<Invoker*> fallback_invokers = {});
  ~Mux() override = default;

  // Register registers a new RPC method handler (service).
  // Matches Go Register in mux.go
  Error Register(Handler* handler);

  // InvokeMethod invokes the method matching the service & method ID.
  // Returns {found, error} - found is false if method not found.
  // If service string is empty, ignore it.
  // Matches Go InvokeMethod in mux.go
  std::pair<bool, Error> InvokeMethod(
      const std::string& service_id,
      const std::string& method_id,
      Stream* strm) override;

  // HasService checks if the service ID exists in the handlers.
  // Matches Go HasService in mux.go
  bool HasService(const std::string& service_id) const override;

  // HasServiceMethod checks if <service-id, method-id> exists in the handlers.
  // Matches Go HasServiceMethod in mux.go
  bool HasServiceMethod(const std::string& service_id, const std::string& method_id) const override;

 private:
  // Mapping from method id to handler
  using MuxMethods = std::unordered_map<std::string, Handler*>;

  // Fallback invokers
  std::vector<Invoker*> fallback_;

  // Read-write mutex guards services_
  mutable std::shared_mutex mtx_;

  // Services contains a mapping from services to handlers
  std::unordered_map<std::string, MuxMethods> services_;
};

// NewMux constructs a new Mux.
// Matches Go NewMux function in mux.go
inline std::unique_ptr<Mux> NewMux(std::vector<Invoker*> fallback_invokers = {}) {
  return std::make_unique<Mux>(std::move(fallback_invokers));
}

}  // namespace starpc
