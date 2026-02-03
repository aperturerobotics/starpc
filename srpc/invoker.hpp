#pragma once

#include <string>
#include <utility>
#include <vector>

#include "errors.hpp"
#include "stream.hpp"

namespace starpc {

// Invoker is a function for invoking SRPC service methods.
// Matches Go Invoker interface in invoker.go
class Invoker {
public:
  virtual ~Invoker() = default;

  // InvokeMethod invokes the method matching the service & method ID.
  // Returns {found, error} - found is false if method not found.
  // If service string is empty, ignore it.
  virtual std::pair<bool, Error> InvokeMethod(const std::string &service_id,
                                              const std::string &method_id,
                                              Stream *strm) = 0;
};

// QueryableInvoker can be used to check if a service and method is implemented.
// Matches Go QueryableInvoker interface in invoker.go
class QueryableInvoker {
public:
  virtual ~QueryableInvoker() = default;

  // HasService checks if the service ID exists in the handlers.
  virtual bool HasService(const std::string &service_id) const = 0;

  // HasServiceMethod checks if <service-id, method-id> exists in the handlers.
  virtual bool HasServiceMethod(const std::string &service_id,
                                const std::string &method_id) const = 0;
};

// InvokerSlice is a list of invokers.
// Matches Go InvokerSlice in invoker.go
class InvokerSlice : public Invoker {
public:
  InvokerSlice() = default;
  explicit InvokerSlice(std::vector<Invoker *> invokers)
      : invokers_(std::move(invokers)) {}

  void Add(Invoker *invoker) { invokers_.push_back(invoker); }

  std::pair<bool, Error> InvokeMethod(const std::string &service_id,
                                      const std::string &method_id,
                                      Stream *strm) override {
    for (auto *invoker : invokers_) {
      if (invoker == nullptr)
        continue;
      auto [found, err] = invoker->InvokeMethod(service_id, method_id, strm);
      if (found || err != Error::OK) {
        return {true, err};
      }
    }
    return {false, Error::OK};
  }

private:
  std::vector<Invoker *> invokers_;
};

// InvokerFunc is a function implementing InvokeMethod.
// Matches Go InvokerFunc in invoker.go
using InvokerFunc = std::function<std::pair<bool, Error>(
    const std::string &service_id, const std::string &method_id, Stream *strm)>;

// InvokerFuncWrapper wraps an InvokerFunc as an Invoker.
class InvokerFuncWrapper : public Invoker {
public:
  explicit InvokerFuncWrapper(InvokerFunc fn) : fn_(std::move(fn)) {}

  std::pair<bool, Error> InvokeMethod(const std::string &service_id,
                                      const std::string &method_id,
                                      Stream *strm) override {
    if (!fn_) {
      return {false, Error::OK};
    }
    return fn_(service_id, method_id, strm);
  }

private:
  InvokerFunc fn_;
};

} // namespace starpc
