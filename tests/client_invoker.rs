use async_trait::async_trait;
use bytes::Bytes;
use starpc::testing::{create_test_pair, SingleInMemoryOpener};
use starpc::{Client, ClientInvoker, Context, Error, Invoker, Result, Server, SrpcClient, Stream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

struct Remote(mpsc::UnboundedSender<Context>);

#[async_trait]
impl Invoker for Remote {
    async fn invoke_method(
        &self,
        service: &str,
        method: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        assert_eq!(service, "remote.Service");
        let result = async {
            match method {
                "Echo" => loop {
                    match stream.recv_bytes().await {
                        Ok(data) => stream.send_bytes(data).await?,
                        Err(Error::StreamClosed) => return Ok(()),
                        Err(error) => return Err(error),
                    }
                },
                "Early" => stream.send_bytes(Bytes::from_static(b"finished")).await,
                "Fail" => {
                    stream.send_bytes(Bytes::from_static(b"partial")).await?;
                    Err(Error::Remote("remote refused".into()))
                }
                "Wait" => {
                    // Observe the caller's half-close before waiting for its later cancellation.
                    assert!(matches!(
                        stream.recv_bytes().await,
                        Err(Error::StreamClosed)
                    ));
                    self.0.send(stream.context().clone()).unwrap();
                    stream.context().cancelled().await;
                    Ok(())
                }
                _ => Err(Error::Unimplemented),
            }
        }
        .await;
        (true, result)
    }
}

struct ProxyPair {
    client: SrpcClient<SingleInMemoryOpener>,
    calls: mpsc::UnboundedReceiver<Context>,
    owners: JoinSet<Result<()>>,
}

impl ProxyPair {
    fn new() -> Self {
        let (entered, calls) = mpsc::unbounded_channel();
        let (remote_opener, remote_io) = create_test_pair();
        let (client_opener, proxy_io) = create_test_pair();
        let mut owners = JoinSet::new();
        owners.spawn(async move { Server::new(Remote(entered)).handle_stream(remote_io).await });
        owners.spawn(async move {
            let proxy = ClientInvoker::new(SrpcClient::new(remote_opener));
            Server::new(proxy).handle_stream(proxy_io).await
        });
        Self {
            client: SrpcClient::new(client_opener),
            calls,
            owners,
        }
    }

    async fn finish(mut self) {
        drop(self.client);
        while let Some(result) = self.owners.join_next().await {
            result.unwrap().unwrap();
        }
    }
}

#[tokio::test]
async fn proxy_preserves_empty_unary_messages() {
    let pair = ProxyPair::new();
    let _: () = pair
        .client
        .exec_call("remote.Service", "Echo", &())
        .await
        .unwrap();
    pair.finish().await;
}

#[tokio::test]
async fn proxy_streams_both_directions_and_half_closes() {
    let pair = ProxyPair::new();
    let stream = pair
        .client
        .new_stream("remote.Service", "Echo", None)
        .await
        .unwrap();
    for bytes in [
        Bytes::new(),
        Bytes::from_static(b"one"),
        Bytes::from_static(b"two"),
    ] {
        stream.send_bytes(bytes.clone()).await.unwrap();
        assert_eq!(stream.recv_bytes().await.unwrap(), bytes);
    }
    stream.close_send().await.unwrap();
    assert!(matches!(
        stream.recv_bytes().await,
        Err(Error::StreamClosed)
    ));
    stream.close().await.unwrap();
    pair.finish().await;
}

#[tokio::test]
async fn remote_completion_does_not_wait_for_caller_half_close() {
    let pair = ProxyPair::new();
    let stream = pair
        .client
        .new_stream("remote.Service", "Early", None)
        .await
        .unwrap();
    assert_eq!(stream.recv_bytes().await.unwrap().as_ref(), b"finished");
    assert!(matches!(
        stream.recv_bytes().await,
        Err(Error::StreamClosed)
    ));
    stream.close().await.unwrap();
    pair.finish().await;
}

#[tokio::test]
async fn proxy_preserves_remote_error_after_partial_output() {
    let pair = ProxyPair::new();
    let stream = pair
        .client
        .new_stream("remote.Service", "Fail", None)
        .await
        .unwrap();
    assert_eq!(stream.recv_bytes().await.unwrap().as_ref(), b"partial");
    let error = stream.recv_bytes().await.unwrap_err();
    assert!(matches!(error, Error::Remote(message) if message.contains("remote refused")));
    stream.close().await.unwrap();
    pair.finish().await;
}

#[tokio::test]
async fn caller_cancellation_after_half_close_cancels_remote_work() {
    let mut pair = ProxyPair::new();
    let stream = pair
        .client
        .new_stream("remote.Service", "Wait", None)
        .await
        .unwrap();
    stream.close_send().await.unwrap();
    let context = pair.calls.recv().await.unwrap();
    stream.close().await.unwrap();
    context.cancelled().await;
    pair.finish().await;
}
