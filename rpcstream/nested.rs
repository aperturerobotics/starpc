//! RpcStream trait and functions for opening/handling nested RPC streams.

use async_trait::async_trait;
use bytes::Bytes;
use prost::Message;
use std::sync::Arc;

use crate::client::{OpenStream, PacketReceiver};
use crate::error::{Error, Result};
use crate::invoker::Invoker;
use crate::proto::{packet::Body, Packet};
use crate::rpc::{PacketWriter, ServerRpc};
use crate::server::serve_rpc;
use crate::stream::{Context, Stream};

use super::RpcStreamWriter;
use super::{rpc_stream_packet, RpcAck, RpcStreamInit, RpcStreamPacket};

/// RpcStream is a bidirectional stream for RpcStreamPacket messages.
///
/// This trait extends the base Stream trait with typed send/recv operations
/// for RpcStreamPacket messages.
#[async_trait]
pub trait RpcStream: Stream {
    /// Sends an RpcStreamPacket.
    async fn send_packet(&self, packet: &RpcStreamPacket) -> Result<()>;

    /// Receives an RpcStreamPacket.
    async fn recv_packet(&self) -> Result<RpcStreamPacket>;
}

/// Generic RpcStream implementation wrapping any Stream.
pub struct RpcStreamImpl<S: Stream> {
    inner: S,
}

impl<S: Stream> RpcStreamImpl<S> {
    /// Creates a new RpcStreamImpl wrapping the given stream.
    pub fn new(inner: S) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl<S: Stream + Send + Sync> Stream for RpcStreamImpl<S> {
    fn context(&self) -> &Context {
        self.inner.context()
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        self.inner.send_bytes(data).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        self.inner.recv_bytes().await
    }

    async fn close_send(&self) -> Result<()> {
        self.inner.close_send().await
    }

    async fn close(&self) -> Result<()> {
        self.inner.close().await
    }
}

#[async_trait]
impl<S: Stream + Send + Sync> RpcStream for RpcStreamImpl<S> {
    async fn send_packet(&self, packet: &RpcStreamPacket) -> Result<()> {
        let data = packet.encode_to_vec();
        self.inner.send_bytes(Bytes::from(data)).await
    }

    async fn recv_packet(&self) -> Result<RpcStreamPacket> {
        let data = self.inner.recv_bytes().await?;
        RpcStreamPacket::decode(&data[..]).map_err(Error::InvalidMessage)
    }
}

// Implement RpcStream for Arc<S> where S: RpcStream
#[async_trait]
impl<S: RpcStream + ?Sized + Send + Sync> RpcStream for Arc<S> {
    async fn send_packet(&self, packet: &RpcStreamPacket) -> Result<()> {
        (**self).send_packet(packet).await
    }

    async fn recv_packet(&self) -> Result<RpcStreamPacket> {
        (**self).recv_packet().await
    }
}

/// Resolves a component ID to its invoker. `released` is called when the
/// stream is released; returns `Some((invoker, release_fn))` when found.
pub type RpcStreamGetter = Arc<
    dyn Fn(
            &Context,
            &str,
            Box<dyn FnOnce() + Send>,
        ) -> Option<(Arc<dyn Invoker>, Box<dyn FnOnce() + Send>)>
        + Send
        + Sync,
>;

impl RpcStreamPacket {
    /// Creates a new Init packet.
    pub fn new_init(component_id: String) -> Self {
        Self {
            body: Some(rpc_stream_packet::Body::Init(RpcStreamInit {
                component_id,
            })),
        }
    }

    /// Creates a new Ack packet.
    pub fn new_ack(error: String) -> Self {
        Self {
            body: Some(rpc_stream_packet::Body::Ack(RpcAck { error })),
        }
    }

    /// Creates a new Data packet.
    pub fn new_data(data: impl Into<Vec<u8>>) -> Self {
        Self {
            body: Some(rpc_stream_packet::Body::Data(data.into())),
        }
    }
}

/// Opens an RPC stream with a remote component.
///
/// Performs the client-side init/ack handshake: sends `RpcStreamInit` with
/// the component ID, then optionally waits for the server's `RpcAck` and
/// reports a remote error ack as `Error::Remote`.
pub async fn open_rpc_stream<S: RpcStream + Send + Sync>(
    stream: &S,
    component_id: &str,
    wait_ack: bool,
) -> Result<()> {
    // Send the init packet
    let init_packet = RpcStreamPacket::new_init(component_id.to_string());
    stream.send_packet(&init_packet).await?;

    // Wait for the ack when requested and report a remote error ack.
    if wait_ack {
        let ack_packet = stream.recv_packet().await?;
        let Some(rpc_stream_packet::Body::Ack(ack)) = ack_packet.body else {
            return Err(Error::UnrecognizedPacket);
        };
        if !ack.error.is_empty() {
            return Err(Error::Remote(format!("remote: {}", ack.error)));
        }
    }

    Ok(())
}

/// Handles the server side of an incoming RPC stream.
///
/// Receives `RpcStreamInit`, looks up the invoker for that component ID with
/// `getter`, sends `RpcAck` (with an error when not found), then serves the one
/// RPC the stream carries: its `CallStart` picks the method, and later packets
/// feed the call until it settles or the stream closes.
pub async fn handle_rpc_stream<S: RpcStream + Send + Sync + 'static>(
    stream: Arc<S>,
    getter: RpcStreamGetter,
) -> Result<()> {
    // Read the init packet and take the component ID from it.
    let init_packet = stream.recv_packet().await?;
    let Some(rpc_stream_packet::Body::Init(init)) = init_packet.body else {
        return Err(Error::UnrecognizedPacket);
    };
    let component_id = init.component_id;

    // Look up the invoker; releasing the component cancels the stream's context.
    let ctx = stream.context().child();
    let _cancel = ctx.cancel_token().drop_guard_ref();
    let ctx_cancel = ctx.clone();
    let released = Box::new(move || ctx_cancel.cancel());
    let lookup_result = getter(&ctx, &component_id, released);

    // Report a missing component with an error ack.
    let Some((invoker, release_fn)) = lookup_result else {
        let err_msg = format!("no server for component: {}", component_id);
        stream
            .send_packet(&RpcStreamPacket::new_ack(err_msg.clone()))
            .await?;
        return Err(Error::Remote(err_msg));
    };

    // Release the component when the stream is done, however it ends.
    let _release_guard = scopeguard::guard(release_fn, |release| release());

    // Send the success ack.
    stream
        .send_packet(&RpcStreamPacket::new_ack(String::new()))
        .await?;

    // The stream ends before a call starts.
    let Some(first) = next_packet(stream.as_ref()).await? else {
        return Ok(());
    };
    let Some(Body::CallStart(call_start)) = first.body else {
        return Err(Error::ExpectedCallStart);
    };

    // Create the server RPC over the stream.
    let writer: Arc<dyn PacketWriter> = Arc::new(RpcStreamWriter::new(stream.clone()));
    let rpc = Arc::new(ServerRpc::from_call_start(ctx.child(), call_start, writer));

    // Serve the call while the stream feeds it; a closed stream ends the call.
    let serve = serve_rpc(invoker.as_ref(), &rpc);
    tokio::pin!(serve);
    tokio::select! {
        () = &mut serve => Ok(()),
        pumped = pump_packets(stream.as_ref(), &rpc) => {
            let _ = rpc.handle_stream_close(None).await;
            serve.await;
            pumped
        }
    }
}

/// Receives the next packet the stream carries for its RPC.
///
/// Returns `None` once the stream closes. Packets other than data are
/// ignored, and data that is not a packet is an error.
async fn next_packet<S: RpcStream + ?Sized>(stream: &S) -> Result<Option<Packet>> {
    loop {
        let rpc_packet = match stream.recv_packet().await {
            Ok(packet) => packet,
            Err(Error::StreamClosed) => return Ok(None),
            Err(err) => return Err(err),
        };
        if let Some(rpc_stream_packet::Body::Data(data)) = rpc_packet.body {
            return Packet::decode(&data[..])
                .map(Some)
                .map_err(Error::InvalidMessage);
        }
    }
}

/// Delivers the stream's packets to the RPC until the stream closes.
///
/// Returns early with the error of a packet that cannot be read or that the
/// RPC rejects as a protocol violation.
async fn pump_packets<S: RpcStream + ?Sized>(stream: &S, rpc: &ServerRpc) -> Result<()> {
    while let Some(packet) = next_packet(stream).await? {
        rpc.handle_packet(packet).await?;
    }

    Ok(())
}

/// Creates an OpenStream implementation that opens an RPC stream with
/// `caller` and performs the init/ack handshake, so a Client can operate
/// over a nested RPC stream.
pub fn new_rpc_stream_open_stream<F, Fut, S>(
    caller: F,
    component_id: String,
    wait_ack: bool,
) -> impl OpenStream
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S>> + Send + 'static,
    S: Stream + Send + Sync + 'static,
{
    RpcStreamOpener {
        caller: Arc::new(caller),
        component_id,
        wait_ack,
        _phantom: std::marker::PhantomData,
    }
}

/// Opens nested RPC streams to one component ID over caller-provided streams.
struct RpcStreamOpener<F, S> {
    caller: Arc<F>,
    component_id: String,
    wait_ack: bool,
    _phantom: std::marker::PhantomData<S>,
}

#[async_trait]
impl<F, Fut, S> OpenStream for RpcStreamOpener<F, S>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S>> + Send + 'static,
    S: Stream + Send + Sync + 'static,
{
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
        // Open the underlying stream
        let stream = (self.caller)().await?;
        let rpc_stream = Arc::new(RpcStreamImpl::new(stream));

        // Perform the init/ack handshake
        open_rpc_stream(rpc_stream.as_ref(), &self.component_id, self.wait_ack).await?;

        // Create a writer
        let writer: Arc<dyn PacketWriter> = Arc::new(RpcStreamWriter::new(rpc_stream.clone()));

        // The returned receiver owns nested reads without a forwarding task or packet queue.
        let packets = futures::stream::unfold(rpc_stream, |stream| async move {
            next_packet(stream.as_ref())
                .await
                .ok()
                .flatten()
                .map(|packet| (packet, stream))
        });
        Ok((writer, Box::pin(packets)))
    }
}

/// Creates a Client that operates over an RPC stream to `component_id`,
/// opening each stream with `caller` and waiting for the ack when
/// `wait_ack` is set.
pub fn new_rpc_stream_client<F, Fut, S>(
    caller: F,
    component_id: String,
    wait_ack: bool,
) -> crate::SrpcClient<impl OpenStream>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S>> + Send + 'static,
    S: Stream + Send + Sync + 'static,
{
    let opener = new_rpc_stream_open_stream(caller, component_id, wait_ack);
    crate::SrpcClient::new(opener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Mutex;

    struct MockRpcStream {
        ctx: Context,
        send_queue: Mutex<VecDeque<RpcStreamPacket>>,
        recv_queue: Mutex<VecDeque<RpcStreamPacket>>,
        packets: tokio::sync::Notify,
        closed: AtomicBool,
    }

    impl MockRpcStream {
        fn new() -> Self {
            Self {
                ctx: Context::new(),
                send_queue: Mutex::new(VecDeque::new()),
                recv_queue: Mutex::new(VecDeque::new()),
                packets: tokio::sync::Notify::new(),
                closed: AtomicBool::new(false),
            }
        }

        async fn push_recv(&self, packet: RpcStreamPacket) {
            self.recv_queue.lock().await.push_back(packet);
            self.packets.notify_one();
        }

        async fn pop_sent(&self) -> Option<RpcStreamPacket> {
            self.send_queue.lock().await.pop_front()
        }
    }

    #[async_trait]
    impl Stream for MockRpcStream {
        fn context(&self) -> &Context {
            &self.ctx
        }

        async fn send_bytes(&self, data: Bytes) -> Result<()> {
            let packet = RpcStreamPacket::decode(&data[..]).map_err(Error::InvalidMessage)?;
            self.send_queue.lock().await.push_back(packet);
            Ok(())
        }

        async fn recv_bytes(&self) -> Result<Bytes> {
            loop {
                if let Some(packet) = self.recv_queue.lock().await.pop_front() {
                    return Ok(Bytes::from(packet.encode_to_vec()));
                }
                if self.closed.load(Ordering::SeqCst) {
                    return Err(Error::StreamClosed);
                }
                // Wake on the next pushed packet or close.
                self.packets.notified().await;
            }
        }

        async fn close_send(&self) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            self.packets.notify_one();
            Ok(())
        }
    }

    #[async_trait]
    impl RpcStream for MockRpcStream {
        async fn send_packet(&self, packet: &RpcStreamPacket) -> Result<()> {
            self.send_queue.lock().await.push_back(packet.clone());
            Ok(())
        }

        async fn recv_packet(&self) -> Result<RpcStreamPacket> {
            loop {
                if let Some(packet) = self.recv_queue.lock().await.pop_front() {
                    return Ok(packet);
                }
                if self.closed.load(Ordering::SeqCst) {
                    return Err(Error::StreamClosed);
                }
                // Wake on the next pushed packet or close.
                self.packets.notified().await;
            }
        }
    }

    /// Invoker whose one method echoes the first message it receives.
    struct EchoInvoker;

    #[async_trait]
    impl Invoker for EchoInvoker {
        async fn invoke_method(
            &self,
            _service_id: &str,
            _method_id: &str,
            stream: Box<dyn Stream>,
        ) -> (bool, Result<()>) {
            let echoed = async {
                let data = stream.recv_bytes().await?;
                stream.send_bytes(data).await
            };

            (true, echoed.await)
        }
    }

    /// Wraps a packet as the data of an RPC stream packet.
    fn data_packet(body: crate::proto::packet::Body) -> RpcStreamPacket {
        RpcStreamPacket::new_data(Packet { body: Some(body) }.encode_to_vec())
    }

    #[tokio::test]
    async fn test_handle_rpc_stream_delivers_call_data_and_settles() {
        let stream = Arc::new(MockRpcStream::new());
        stream
            .push_recv(RpcStreamPacket::new_init("echo".into()))
            .await;
        stream
            .push_recv(data_packet(Body::CallStart(crate::proto::CallStart {
                rpc_service: "test.Service".into(),
                rpc_method: "Echo".into(),
                data: Vec::new(),
                data_is_zero: false,
            })))
            .await;

        // The message arrives after the CallStart, in its own packet.
        stream
            .push_recv(data_packet(Body::CallData(crate::proto::CallData {
                data: b"ping".to_vec(),
                ..Default::default()
            })))
            .await;

        let getter: RpcStreamGetter = Arc::new(|_ctx, _id, _released| {
            let invoker: Arc<dyn Invoker> = Arc::new(EchoInvoker);
            Some((invoker, Box::new(|| {}) as Box<dyn FnOnce() + Send>))
        });
        handle_rpc_stream(stream.clone(), getter).await.unwrap();

        // The stream carries the ack, the echoed message, and the completion.
        let ack = stream.pop_sent().await.unwrap();
        assert!(
            matches!(ack.body, Some(rpc_stream_packet::Body::Ack(ref ack)) if ack.error.is_empty())
        );
        let mut sent = Vec::new();
        while let Some(packet) = stream.pop_sent().await {
            let Some(rpc_stream_packet::Body::Data(data)) = packet.body else {
                panic!("expected a data packet");
            };
            sent.push(Packet::decode(&data[..]).unwrap());
        }
        assert!(matches!(
            sent.first().and_then(|p| p.body.as_ref()),
            Some(Body::CallData(call)) if call.data == b"ping"
        ));
        assert!(matches!(
            sent.last().and_then(|p| p.body.as_ref()),
            Some(Body::CallData(call)) if call.complete
        ));
    }

    #[tokio::test]
    async fn test_open_rpc_stream_no_ack() {
        let stream = MockRpcStream::new();

        let result = open_rpc_stream(&stream, "test-component", false).await;
        assert!(result.is_ok());

        // Check that init was sent
        let sent = stream.pop_sent().await.unwrap();
        match sent.body {
            Some(rpc_stream_packet::Body::Init(init)) => {
                assert_eq!(init.component_id, "test-component");
            }
            _ => panic!("Expected Init packet"),
        }
    }

    #[tokio::test]
    async fn test_open_rpc_stream_with_ack() {
        let stream = MockRpcStream::new();

        // Pre-queue an ack response
        stream
            .push_recv(RpcStreamPacket::new_ack(String::new()))
            .await;

        let result = open_rpc_stream(&stream, "test-component", true).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_open_rpc_stream_with_error_ack() {
        let stream = MockRpcStream::new();

        // Pre-queue an error ack response
        stream
            .push_recv(RpcStreamPacket::new_ack("component not found".to_string()))
            .await;

        let result = open_rpc_stream(&stream, "test-component", true).await;
        assert!(matches!(result, Err(Error::Remote(_))));
    }
}
