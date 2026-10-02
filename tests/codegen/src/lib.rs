//! Compile checks for multiple services and RPC names shared with Rust traits.

include!(concat!(env!("OUT_DIR"), "/fixture.rs"));

/// Incoming cancellation reaches unary implementations through the generated handler.
#[cfg(test)]
mod tests {
    use starpc::{Client, Context, Error, Result, Server, SrpcClient};
    use tokio::sync::mpsc;

    use super::{Message, UnaryClient, UnaryClientImpl, UnaryHandler, UnaryServer};

    /// Announces the received context and keeps the unary call active until its transport ends.
    struct Waiting {
        /// Each admitted call reports its actual transport context to the test.
        entered: mpsc::UnboundedSender<Context>,
    }

    #[starpc::async_trait]
    impl UnaryServer for Waiting {
        /// Waits on the transport's actual context, rather than a replacement cancellation token.
        async fn clone(&self, context: &Context, _request: Message) -> Result<Message> {
            // Signal only after generated dispatch entered the service implementation.
            self.entered.send(context.clone()).unwrap();

            // Cancellation must wake the work the unary service is actually awaiting.
            context.cancelled().await;
            Err(Error::Cancelled)
        }
    }

    /// Explicit peer closure reaches an active unary service without changing its wire messages.
    #[tokio::test]
    async fn unary_receives_peer_cancellation() {
        // Connect the real generated handler to StarPC framing over a duplex transport.
        let (entered, mut received) = mpsc::unbounded_channel();
        let server = Server::new(UnaryHandler::new(Waiting { entered }));
        let (opener, transport) = starpc::testing::create_test_pair();
        let server = tokio::spawn(async move { server.handle_stream(transport).await });
        let client = SrpcClient::new(opener);
        let call = client
            .new_stream("fixture.Unary", "Clone", Some(&[]))
            .await
            .unwrap();
        let context = received.recv().await.unwrap();
        assert!(!context.is_cancelled());

        // The remote close wakes the service and lets the entire server operation finish.
        call.close().await.unwrap();
        context.cancelled().await;
        server.await.unwrap().unwrap();
    }

    /// Abandoning a server call cancels its context and releases its packet reader and transport.
    #[tokio::test]
    async fn dropped_server_call_releases_transport() {
        // Wait for actual service admission before dropping the owner of its packet reader.
        let (entered, mut received) = mpsc::unbounded_channel();
        let server = Server::new(UnaryHandler::new(Waiting { entered }));
        let (opener, transport) = starpc::testing::create_test_pair();
        let server = tokio::spawn(async move { server.handle_stream(transport).await });
        let client = SrpcClient::new(opener);
        let call = client
            .new_stream("fixture.Unary", "Clone", Some(&[]))
            .await
            .unwrap();
        let context = received.recv().await.unwrap();

        // Joining the aborted owner must also release its borrowed packet-reader future.
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        context.cancelled().await;
        assert!(matches!(
            call.recv_bytes().await,
            Err(Error::ClosedBeforeCompletion)
        ));
    }

    /// A finite listener keeps its accepted unary calls alive until each has completed.
    #[tokio::test]
    async fn serve_drains_accepted_calls() {
        // Two independent transports share the same generated service and server lifetime.
        let (entered, mut received) = mpsc::unbounded_channel();
        let server = Server::new(UnaryHandler::new(Waiting { entered }));
        let (first, first_transport) = starpc::testing::create_test_pair();
        let (second, second_transport) = starpc::testing::create_test_pair();
        let incoming = futures::stream::iter([Ok(first_transport), Ok(second_transport)]);
        let server = tokio::spawn(async move { server.serve(incoming).await });
        let first = SrpcClient::new(first);
        let second = SrpcClient::new(second);
        let first = first
            .new_stream("fixture.Unary", "Clone", Some(&[]))
            .await
            .unwrap();
        let second = second
            .new_stream("fixture.Unary", "Clone", Some(&[]))
            .await
            .unwrap();
        let first_context = received.recv().await.unwrap();
        let second_context = received.recv().await.unwrap();
        assert!(!server.is_finished());

        // Closing both accepted calls allows the finite listener's owner to return.
        first.close().await.unwrap();
        second.close().await.unwrap();
        first_context.cancelled().await;
        second_context.cancelled().await;
        server.await.unwrap().unwrap();
    }

    /// Dropping a generated unary call releases its transport and wakes the peer's service context.
    #[tokio::test]
    async fn dropped_unary_client_cancels_peer_work() {
        // Enter a real generated service before abandoning the caller's borrowing future.
        let (entered, mut received) = mpsc::unbounded_channel();
        let server = Server::new(UnaryHandler::new(Waiting { entered }));
        let (opener, transport) = starpc::testing::create_test_pair();
        let server = tokio::spawn(async move { server.handle_stream(transport).await });
        let client = UnaryClientImpl::new(SrpcClient::new(opener));
        let call =
            tokio::spawn(async move { UnaryClient::clone(&client, &Message::default()).await });
        let context = received.recv().await.unwrap();

        // There is no detached packet pump retaining the dropped client's idle connection.
        call.abort();
        assert!(call.await.unwrap_err().is_cancelled());
        context.cancelled().await;
        server.await.unwrap().unwrap();
    }
}
