//! Half-close tests for the generated Rust callers.
//!
//! The half-close is only a notice once the request is written: a caller that
//! half-closes after the remote ended the call must still read the buffered
//! responses and the call's outcome.

#[allow(dead_code)]
mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt as _;
use prost::Message;
use starpc::client::OpenStream;
use starpc::testing::{create_pipe_default, create_test_pair, SingleInMemoryOpener};
use starpc::{Client, Error, Mux, PacketCodec, Result, Server, SrpcClient, Stream, StreamExt};
use tokio::task::JoinHandle;
use tokio_util::codec::FramedRead;

use gen::{EchoMsg, EchoerClient, EchoerClientImpl, EchoerHandler, EchoerServer};

const BODY_TXT: &str = "hello world via starpc half-close test";

/// Answers each streaming call once and completes it.
struct OnceEchoServer;

#[async_trait]
impl EchoerServer for OnceEchoServer {
    async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
        Ok(request)
    }

    async fn echo_server_stream(&self, request: EchoMsg, stream: Box<dyn Stream>) -> Result<()> {
        stream.msg_send(&request).await
    }

    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        // Reply to the first message without waiting for the half-close.
        stream.msg_recv().await
    }

    async fn echo_bidi_stream(&self, _stream: Box<dyn Stream>) -> Result<()> {
        Err(Error::Unimplemented)
    }

    async fn rpc_stream(&self, _stream: Box<dyn Stream>) -> Result<()> {
        Err(Error::Unimplemented)
    }

    async fn do_nothing(
        &self,
        _context: &starpc::Context,
        request: gen::Empty,
    ) -> Result<gen::Empty> {
        Ok(request)
    }
}

/// Returns each new stream only after its transport has closed, so the
/// generated caller half-closes after the remote already ended the call.
struct EndedClient<T: OpenStream> {
    client: SrpcClient<T>,
}

#[async_trait]
impl<T: OpenStream + 'static> Client for EndedClient<T> {
    async fn exec_call<I, O>(&self, service: &str, method: &str, input: &I) -> Result<O>
    where
        I: Message + Send + Sync,
        O: Message + Default,
    {
        self.client.exec_call(service, method, input).await
    }

    async fn new_stream(
        &self,
        service: &str,
        method: &str,
        first_msg: Option<&[u8]>,
    ) -> Result<Box<dyn Stream>> {
        let stream = self.client.new_stream(service, method, first_msg).await?;
        // The transport close handler cancels the context after it settles
        // the call's outcome and closes the writer.
        stream.context().cancelled().await;
        Ok(stream)
    }
}

/// Returns one transport opener and the server task that its caller must join.
fn serve_once_echo() -> (SingleInMemoryOpener, JoinHandle<Result<()>>) {
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(OnceEchoServer)))
        .unwrap();
    let (opener, server_stream) = create_test_pair();
    let server = Server::with_arc(mux);
    let task = tokio::spawn(async move { server.handle_stream(server_stream).await });
    (opener, task)
}

/// Returns a transport that closes after CallStart and the peer task to join after observation.
fn drop_after_request() -> (SingleInMemoryOpener, JoinHandle<()>) {
    // Use the actual framing boundary to order peer closure after request admission.
    let (client_stream, server_stream) = create_pipe_default();
    let task = tokio::spawn(async move {
        let mut framed = FramedRead::new(server_stream, PacketCodec::new());
        let _ = framed.next().await;
    });
    (SingleInMemoryOpener::new(client_stream), task)
}

#[tokio::test]
async fn server_stream_completed_before_close_send() {
    // Complete the server stream before the generated caller half-closes.
    let (opener, server) = serve_once_echo();
    let client = EchoerClientImpl::new(EndedClient {
        client: SrpcClient::new(opener),
    });
    let request = EchoMsg {
        body: BODY_TXT.into(),
    };
    let stream = client
        .echo_server_stream(&request)
        .await
        .expect("server stream discarded after remote completion");

    // Read the buffered response, then the clean completion.
    let msg = stream.recv().await.expect("buffered response lost");
    assert_eq!(msg.body, BODY_TXT);
    let end = stream.recv().await;
    assert!(
        matches!(end, Err(Error::StreamClosed)),
        "expected StreamClosed after completion, got {end:?}"
    );
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn client_stream_completed_before_close_send() {
    let (opener, server) = serve_once_echo();
    let client = EchoerClientImpl::new(SrpcClient::new(opener));
    let stream = client.echo_client_stream().await.unwrap();

    // Send the one request and wait for the call to end.
    let request = EchoMsg {
        body: BODY_TXT.into(),
    };
    stream.send(&request).await.unwrap();
    stream.context().cancelled().await;

    // The half-close fails, but the reply is still readable.
    let msg = stream.close_and_recv().await.expect("buffered reply lost");
    assert_eq!(msg.body, BODY_TXT);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn server_stream_transport_failure_before_close_send() {
    let (opener, server) = drop_after_request();
    let client = EchoerClientImpl::new(EndedClient {
        client: SrpcClient::new(opener),
    });
    let request = EchoMsg {
        body: BODY_TXT.into(),
    };
    let stream = client
        .echo_server_stream(&request)
        .await
        .expect("server stream discarded after transport failure");

    // Recv reports that the call ended without a verdict.
    let end = stream.recv().await;
    assert!(
        matches!(end, Err(Error::ClosedBeforeCompletion)),
        "expected ClosedBeforeCompletion, got {end:?}"
    );
    server.await.unwrap();
}
