//! Service multiplexer for routing RPC calls.
//!
//! The Mux provides a registry for RPC handlers and routes incoming calls
//! to the appropriate handler based on service and method IDs.
//!
//! This implementation matches the Go Mux behavior, supporting:
//! - Service-level handler registration
//! - Method-level routing within services
//! - Fallback invokers for unmatched calls
//! - Empty service ID handling (searches all services)

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::error::{Error, Result};
use crate::handler::Handler;
use crate::invoker::Invoker;
use crate::stream::Stream;

/// A shared handler reference.
pub type ArcHandler = Arc<dyn Handler>;

/// Method handlers map: method_id -> handler.
type MethodHandlers = HashMap<String, ArcHandler>;

/// Service multiplexer for routing RPC calls to handlers.
///
/// The Mux maintains a registry of handlers and routes incoming RPC calls
/// to the appropriate handler based on service and method IDs.
///
/// # Example
///
/// ```ignore
/// use starpc::{Mux, Handler};
///
/// let mux = Mux::new();
/// mux.register(Arc::new(MyServiceHandler))?;
///
/// // The mux can now route calls to MyServiceHandler
/// ```
pub struct Mux {
    /// Map of service ID -> method ID -> handler.
    /// This matches the Go implementation's structure.
    services: RwLock<HashMap<String, MethodHandlers>>,

    /// Fallback invokers to try if no handler is found.
    fallbacks: RwLock<Vec<Arc<dyn Invoker>>>,
}

impl Default for Mux {
    fn default() -> Self {
        Self::new()
    }
}

impl Mux {
    /// Creates a new empty Mux.
    pub fn new() -> Self {
        Self {
            services: RwLock::new(HashMap::new()),
            fallbacks: RwLock::new(Vec::new()),
        }
    }

    /// Creates a new Mux with fallback invokers.
    ///
    /// Fallback invokers are called in order when no handler matches
    /// the requested service/method.
    pub fn with_fallbacks(fallbacks: Vec<Arc<dyn Invoker>>) -> Self {
        Self {
            services: RwLock::new(HashMap::new()),
            fallbacks: RwLock::new(fallbacks),
        }
    }

    /// Registers a handler for its service.
    ///
    /// The handler is registered for all methods it declares via `method_ids()`.
    ///
    /// # Errors
    ///
    /// Returns `Error::EmptyServiceId` if the handler's service ID is empty.
    pub fn register(&self, handler: ArcHandler) -> Result<()> {
        let service_id = handler.service_id();
        if service_id.is_empty() {
            return Err(Error::EmptyServiceId);
        }

        let method_ids = handler.method_ids();

        let mut services = self.services.write().unwrap();
        let service_methods = services
            .entry(service_id.to_string())
            .or_insert_with(HashMap::new);

        for method_id in method_ids {
            if !method_id.is_empty() {
                service_methods.insert(method_id.to_string(), handler.clone());
            }
        }

        Ok(())
    }

    /// Adds a fallback invoker.
    ///
    /// Fallback invokers are tried in order when no handler matches.
    pub fn add_fallback(&self, invoker: Arc<dyn Invoker>) {
        self.fallbacks.write().unwrap().push(invoker);
    }

    /// Checks if a service is registered.
    pub fn has_service(&self, service_id: &str) -> bool {
        if service_id.is_empty() {
            return false;
        }

        let services = self.services.read().unwrap();
        services
            .get(service_id)
            .map(|methods| !methods.is_empty())
            .unwrap_or(false)
    }

    /// Checks if a service method is registered.
    pub fn has_service_method(&self, service_id: &str, method_id: &str) -> bool {
        if service_id.is_empty() || method_id.is_empty() {
            return false;
        }

        let services = self.services.read().unwrap();
        services
            .get(service_id)
            .and_then(|methods| methods.get(method_id))
            .is_some()
    }

    /// Gets a handler by service ID and method ID.
    fn get_handler(&self, service_id: &str, method_id: &str) -> Option<ArcHandler> {
        let services = self.services.read().unwrap();
        services
            .get(service_id)
            .and_then(|methods| methods.get(method_id).cloned())
    }

    /// Finds a handler that implements the given method (searching all services).
    ///
    /// This is used when service_id is empty.
    fn find_handler_for_method(&self, method_id: &str) -> Option<ArcHandler> {
        let services = self.services.read().unwrap();
        for methods in services.values() {
            if let Some(handler) = methods.get(method_id) {
                return Some(handler.clone());
            }
        }
        None
    }
}

/// QueryableInvoker allows checking if methods are implemented without invoking.
///
/// This matches the Go interface of the same name.
pub trait QueryableInvoker {
    /// Checks if the service is registered.
    fn has_service(&self, service_id: &str) -> bool;

    /// Checks if the service method is registered.
    fn has_service_method(&self, service_id: &str, method_id: &str) -> bool;
}

impl QueryableInvoker for Mux {
    fn has_service(&self, service_id: &str) -> bool {
        Mux::has_service(self, service_id)
    }

    fn has_service_method(&self, service_id: &str, method_id: &str) -> bool {
        Mux::has_service_method(self, service_id, method_id)
    }
}

#[async_trait]
impl Invoker for Mux {
    async fn invoke_method(
        &self,
        service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        // Look up the handler
        let handler = if service_id.is_empty() {
            // If service_id is empty, search all services for the method
            self.find_handler_for_method(method_id)
        } else {
            self.get_handler(service_id, method_id)
        };

        if let Some(h) = handler {
            // Invoke the handler
            return h.invoke_method(service_id, method_id, stream).await;
        }

        // Try the first fallback invoker.
        // Only the first fallback gets a chance because the stream is consumed by the call.
        // This matches Go behavior where the stream cannot be reused after an invocation attempt.
        let maybe_fallback = self.fallbacks.read().unwrap().first().cloned();
        if let Some(fallback) = maybe_fallback {
            return fallback.invoke_method(service_id, method_id, stream).await;
        }

        (false, Err(Error::Unimplemented))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::Context;

    struct TestHandler {
        service_id: &'static str,
        method_ids: &'static [&'static str],
    }

    #[async_trait]
    impl Invoker for TestHandler {
        async fn invoke_method(
            &self,
            _service_id: &str,
            _method_id: &str,
            _stream: Box<dyn Stream>,
        ) -> (bool, Result<()>) {
            (true, Ok(()))
        }
    }

    impl Handler for TestHandler {
        fn service_id(&self) -> &'static str {
            self.service_id
        }

        fn method_ids(&self) -> &'static [&'static str] {
            self.method_ids
        }
    }

    #[test]
    fn test_mux_register() {
        let mux = Mux::new();
        let handler = Arc::new(TestHandler {
            service_id: "test.Service",
            method_ids: &["Method1", "Method2"],
        });

        mux.register(handler).unwrap();

        assert!(mux.has_service("test.Service"));
        assert!(mux.has_service_method("test.Service", "Method1"));
        assert!(mux.has_service_method("test.Service", "Method2"));
        assert!(!mux.has_service_method("test.Service", "Method3"));
        assert!(!mux.has_service("other.Service"));
    }

    #[test]
    fn test_mux_register_empty_service_id() {
        let mux = Mux::new();
        let handler = Arc::new(TestHandler {
            service_id: "",
            method_ids: &["Method1"],
        });

        let result = mux.register(handler);
        assert!(matches!(result, Err(Error::EmptyServiceId)));
    }

    #[test]
    fn test_mux_has_service_empty_id() {
        let mux = Mux::new();
        assert!(!mux.has_service(""));
    }

    #[test]
    fn test_mux_has_service_method_empty_ids() {
        let mux = Mux::new();
        let handler = Arc::new(TestHandler {
            service_id: "test.Service",
            method_ids: &["Method1"],
        });
        mux.register(handler).unwrap();

        assert!(!mux.has_service_method("", "Method1"));
        assert!(!mux.has_service_method("test.Service", ""));
    }

    #[test]
    fn test_mux_find_handler_for_method() {
        let mux = Mux::new();
        let handler = Arc::new(TestHandler {
            service_id: "test.Service",
            method_ids: &["UniqueMethod"],
        });
        mux.register(handler).unwrap();

        // Should find handler when searching all services
        let found = mux.find_handler_for_method("UniqueMethod");
        assert!(found.is_some());

        let not_found = mux.find_handler_for_method("NonExistent");
        assert!(not_found.is_none());
    }

    #[tokio::test]
    async fn test_mux_invoke_with_empty_service_id() {
        let mux = Mux::new();
        let handler = Arc::new(TestHandler {
            service_id: "test.Service",
            method_ids: &["TestMethod"],
        });
        mux.register(handler).unwrap();

        // Create a mock stream
        struct MockStream;

        #[async_trait]
        impl Stream for MockStream {
            fn context(&self) -> &Context {
                static CTX: std::sync::OnceLock<Context> = std::sync::OnceLock::new();
                CTX.get_or_init(Context::new)
            }

            async fn send_bytes(&self, _data: bytes::Bytes) -> Result<()> {
                Ok(())
            }

            async fn recv_bytes(&self) -> Result<bytes::Bytes> {
                Err(Error::StreamClosed)
            }

            async fn close_send(&self) -> Result<()> {
                Ok(())
            }

            async fn close(&self) -> Result<()> {
                Ok(())
            }
        }

        // Should find the method even with empty service ID
        let (handled, result) = mux.invoke_method("", "TestMethod", Box::new(MockStream)).await;
        assert!(handled);
        assert!(result.is_ok());
    }
}
