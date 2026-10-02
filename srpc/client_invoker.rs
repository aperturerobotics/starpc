//! Proxy invocations through an existing client while retaining both directions.

use async_trait::async_trait;

use crate::{Client, Error, Invoker, Result, Stream};

/// Routes incoming methods through one client, preserving the remote terminal result.
pub struct ClientInvoker<C> {
    client: C,
}

impl<C: Client> ClientInvoker<C> {
    /// Wraps a client whose transport and routing remain under its existing owner.
    pub fn new(client: C) -> Self {
        Self { client }
    }
}

#[async_trait]
impl<C: Client> Invoker for ClientInvoker<C> {
    async fn invoke_method(
        &self,
        service: &str,
        method: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        // Opening a remote stream remains within the incoming call's cancellation.
        let remote = tokio::select! {
            () = stream.context().cancelled() => return (true, Err(Error::Cancelled)),
            remote = self.client.new_stream(service, method, None) => match remote {
                Ok(remote) => remote,
                Err(error) => return (true, Err(error)),
            },
        };

        // Request forwarding may half-close before the remote sends its result.
        let requests = async {
            match forward_messages(stream.as_ref(), remote.as_ref()).await {
                Ok(()) => remote.close_send().await,
                Err(error) => {
                    let _ = remote.close().await;
                    Err(error)
                }
            }
        };
        let responses = forward_messages(remote.as_ref(), stream.as_ref());
        tokio::pin!(requests, responses);

        // A remote result settles the call even if its caller has not half-closed.
        let exchange = async {
            tokio::select! {
                result = &mut responses => result,
                _ = &mut requests => responses.await,
            }
        };
        let result = tokio::select! {
            result = exchange => result,
            () = stream.context().cancelled() => Err(Error::Cancelled),
        };
        let _ = remote.close().await;
        (true, result)
    }
}

/// Copies every message, including empty protobufs, until the source half-closes.
async fn forward_messages(source: &dyn Stream, target: &dyn Stream) -> Result<()> {
    loop {
        let data = match source.recv_bytes().await {
            Ok(data) => data,
            Err(Error::StreamClosed) => return Ok(()),
            Err(error) => return Err(error),
        };
        target.send_bytes(data).await?;
    }
}
