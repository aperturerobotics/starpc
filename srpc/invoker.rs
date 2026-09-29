//! Invoker trait for RPC method invocation.
//!
//! The Invoker trait defines the interface for dispatching RPC calls to handlers.
//! This is the core abstraction that allows the Mux, Server, and generated code
//! to route calls appropriately.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::Result;
use crate::stream::Stream;

/// Dispatches incoming RPC calls to a handler implementation.
///
/// The Mux implements this trait to route calls by service and method ID.
/// `invoke_method` returns `(found, result)`, letting a caller distinguish a
/// method that was not found (`(false, Err(Error::Unimplemented))`) from one
/// that was found and failed (`(true, Err(...))`).
#[async_trait]
pub trait Invoker: Send + Sync {
    /// Invokes the RPC method, consuming `stream` whether or not the method
    /// is found. Returns whether the method was handled and the invocation's
    /// result.
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
        let invoker = TestInvoker {
            should_handle: true,
        };
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
        let invoker: Arc<dyn Invoker> = Arc::new(TestInvoker {
            should_handle: true,
        });
        let (found, result) = invoker
            .invoke_method("svc", "method", Box::new(MockStream))
            .await;

        assert!(found);
        assert!(result.is_ok());
    }
}
