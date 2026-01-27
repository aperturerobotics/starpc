//! Handler trait for RPC service implementations.
//!
//! A Handler is an Invoker that also provides metadata about the service
//! it handles. This allows the Mux to register handlers and route calls
//! based on service and method IDs.

use std::sync::Arc;

use crate::invoker::Invoker;

/// Trait for RPC service handlers.
///
/// A Handler extends Invoker with metadata methods that describe the service
/// and methods it implements. This is the trait that generated service code
/// typically implements.
///
/// # Example
///
/// ```rust,ignore
/// struct MyServiceHandler {
///     // Handler state
/// }
///
/// #[async_trait]
/// impl Invoker for MyServiceHandler {
///     async fn invoke_method(
///         &self,
///         service_id: &str,
///         method_id: &str,
///         stream: Box<dyn Stream>,
///     ) -> (bool, Result<()>) {
///         match method_id {
///             "Method1" => (true, self.method1(stream).await),
///             "Method2" => (true, self.method2(stream).await),
///             _ => (false, Err(Error::Unimplemented)),
///         }
///     }
/// }
///
/// impl Handler for MyServiceHandler {
///     fn service_id(&self) -> &'static str {
///         "my.package.MyService"
///     }
///
///     fn method_ids(&self) -> &'static [&'static str] {
///         &["Method1", "Method2"]
///     }
/// }
/// ```
pub trait Handler: Invoker {
    /// Returns the service ID that this handler implements.
    ///
    /// The service ID is typically the fully-qualified protobuf service name,
    /// e.g., "echo.Echoer" or "my.package.MyService".
    fn service_id(&self) -> &'static str;

    /// Returns the list of method IDs that this handler implements.
    ///
    /// These are the method names as defined in the protobuf service definition.
    fn method_ids(&self) -> &'static [&'static str];
}

/// Boxed Handler trait object.
pub type BoxHandler = Box<dyn Handler>;

/// Arc-wrapped Handler trait object.
pub type ArcHandler = Arc<dyn Handler>;

// Note: We can't provide blanket implementations for Arc<T> and Box<T>
// because Handler extends Invoker which already has these implementations.
// The Mux uses ArcHandler directly.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{Error, Result};
    use crate::stream::{Context, Stream};
    use async_trait::async_trait;

    struct TestHandler;

    #[async_trait]
    impl Invoker for TestHandler {
        async fn invoke_method(
            &self,
            _service_id: &str,
            method_id: &str,
            _stream: Box<dyn Stream>,
        ) -> (bool, Result<()>) {
            match method_id {
                "Method1" | "Method2" => (true, Ok(())),
                _ => (false, Err(Error::Unimplemented)),
            }
        }
    }

    impl Handler for TestHandler {
        fn service_id(&self) -> &'static str {
            "test.Service"
        }

        fn method_ids(&self) -> &'static [&'static str] {
            &["Method1", "Method2"]
        }
    }

    #[test]
    fn test_handler_metadata() {
        let handler = TestHandler;
        assert_eq!(handler.service_id(), "test.Service");
        assert_eq!(handler.method_ids(), &["Method1", "Method2"]);
    }

    #[test]
    fn test_arc_handler() {
        let handler: ArcHandler = Arc::new(TestHandler);
        assert_eq!(handler.service_id(), "test.Service");
        assert_eq!(handler.method_ids(), &["Method1", "Method2"]);
    }

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

    #[tokio::test]
    async fn test_handler_invoke() {
        let handler: ArcHandler = Arc::new(TestHandler);

        let (found, result) = handler
            .invoke_method("test.Service", "Method1", Box::new(MockStream))
            .await;
        assert!(found);
        assert!(result.is_ok());

        let (found, result) = handler
            .invoke_method("test.Service", "Unknown", Box::new(MockStream))
            .await;
        assert!(!found);
        assert!(result.is_err());
    }
}
