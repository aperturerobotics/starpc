//! Invoker trait for RPC method invocation.
//!
//! The Invoker trait defines the interface for dispatching RPC calls to handlers.
//! This is the core abstraction that allows the Mux, Server, and generated code
//! to route calls appropriately.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::Result;
use crate::stream::Stream;

/// Trait for invoking RPC methods.
///
/// An Invoker is responsible for dispatching incoming RPC calls to the
/// appropriate handler implementation. The Mux implements this trait to
/// route calls based on service and method IDs.
///
/// # Return Value
///
/// The `invoke_method` method returns a tuple of `(found, result)`:
/// - `found`: Whether the method was found and handled
/// - `result`: The result of the invocation, or an error
///
/// This design allows callers to distinguish between:
/// - Method not found: `(false, Err(Error::Unimplemented))`
/// - Method found but failed: `(true, Err(...))`
/// - Method found and succeeded: `(true, Ok(()))`
///
/// # Example
///
/// ```rust,ignore
/// #[async_trait]
/// impl Invoker for MyHandler {
///     async fn invoke_method(
///         &self,
///         service_id: &str,
///         method_id: &str,
///         stream: Box<dyn Stream>,
///     ) -> (bool, Result<()>) {
///         match method_id {
///             "MyMethod" => {
///                 // Handle the method
///                 (true, self.my_method(stream).await)
///             }
///             _ => (false, Err(Error::Unimplemented)),
///         }
///     }
/// }
/// ```
#[async_trait]
pub trait Invoker: Send + Sync {
    /// Invokes an RPC method.
    ///
    /// # Arguments
    ///
    /// * `service_id` - The service identifier (e.g., "echo.Echoer")
    /// * `method_id` - The method identifier (e.g., "Echo")
    /// * `stream` - The bidirectional stream for this RPC
    ///
    /// # Returns
    ///
    /// A tuple of (found, result) where:
    /// * `found` - Whether the method was found and handled
    /// * `result` - The result of the invocation
    async fn invoke_method(
        &self,
        service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>);
}

/// Boxed Invoker trait object.
pub type BoxInvoker = Box<dyn Invoker>;

/// Arc-wrapped Invoker trait object.
pub type ArcInvoker = Arc<dyn Invoker>;

// Blanket implementation for Arc<T> where T: Invoker
#[async_trait]
impl<T: Invoker + ?Sized> Invoker for Arc<T> {
    async fn invoke_method(
        &self,
        service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        (**self).invoke_method(service_id, method_id, stream).await
    }
}

// Blanket implementation for Box<T> where T: Invoker
#[async_trait]
impl<T: Invoker + ?Sized> Invoker for Box<T> {
    async fn invoke_method(
        &self,
        service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        (**self).invoke_method(service_id, method_id, stream).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::stream::Context;

    struct TestInvoker {
        should_handle: bool,
    }

    #[async_trait]
    impl Invoker for TestInvoker {
        async fn invoke_method(
            &self,
            _service_id: &str,
            _method_id: &str,
            _stream: Box<dyn Stream>,
        ) -> (bool, Result<()>) {
            if self.should_handle {
                (true, Ok(()))
            } else {
                (false, Err(Error::Unimplemented))
            }
        }
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
    async fn test_invoker_found() {
        let invoker = TestInvoker { should_handle: true };
        let (found, result) = invoker
            .invoke_method("svc", "method", Box::new(MockStream))
            .await;

        assert!(found);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_invoker_not_found() {
        let invoker = TestInvoker {
            should_handle: false,
        };
        let (found, result) = invoker
            .invoke_method("svc", "method", Box::new(MockStream))
            .await;

        assert!(!found);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_arc_invoker() {
        let invoker: Arc<dyn Invoker> = Arc::new(TestInvoker { should_handle: true });
        let (found, result) = invoker
            .invoke_method("svc", "method", Box::new(MockStream))
            .await;

        assert!(found);
        assert!(result.is_ok());
    }
}
