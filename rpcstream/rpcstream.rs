//! RpcStream trait and functions for opening/handling nested RPC streams.

use async_trait::async_trait;
use bytes::Bytes;
use prost::Message;
use std::sync::Arc;

use crate::client::{OpenStream, PacketReceiver};
use crate::error::{Error, Result};
use crate::invoker::Invoker;
use crate::proto::Packet;
use crate::rpc::{PacketWriter, ServerRpc};
use crate::stream::{Context, Stream};

use super::{rpc_stream_packet, RpcAck, RpcStreamInit, RpcStreamPacket};
use super::RpcStreamWriter;

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

/// Getter function to resolve component ID to an invoker.
///
/// # Arguments
/// * `ctx` - Context for the RPC stream
/// * `component_id` - The component ID to look up
/// * `released` - Callback to invoke when the stream is released
///
/// # Returns
/// `Some((invoker, release_fn))` if found, `None` if not found.
pub type RpcStreamGetter = Arc<
    dyn Fn(&Context, &str, Box<dyn FnOnce() + Send>) -> Option<(Arc<dyn Invoker>, Box<dyn FnOnce() + Send>)>
        + Send
        + Sync,
>;

impl RpcStreamPacket {
    /// Creates a new Init packet.
    pub fn new_init(component_id: String) -> Self {
        Self {
            body: Some(rpc_stream_packet::Body::Init(RpcStreamInit { component_id })),
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
/// This function performs the client-side init/ack handshake:
/// 1. Sends RpcStreamInit with the component ID
/// 2. Optionally waits for RpcAck from the server
///
/// # Arguments
/// * `stream` - The underlying RPC stream
/// * `component_id` - The target component ID
/// * `wait_ack` - Whether to wait for acknowledgment
///
/// # Returns
/// Ok(()) on success
pub async fn open_rpc_stream<S: RpcStream + Send + Sync>(
    stream: &S,
    component_id: &str,
    wait_ack: bool,
) -> Result<()> {
    // Send the init packet
    let init_packet = RpcStreamPacket::new_init(component_id.to_string());
    stream.send_packet(&init_packet).await?;

    // Wait for ack if requested
    if wait_ack {
        let ack_packet = stream.recv_packet().await?;
        match ack_packet.body {
            Some(rpc_stream_packet::Body::Ack(ack)) => {
                if !ack.error.is_empty() {
                    return Err(Error::Remote(format!("remote: {}", ack.error)));
                }
            }
            _ => {
                return Err(Error::UnrecognizedPacket);
            }
        }
    }

    Ok(())
}

/// Handles an incoming RPC stream (server side).
///
/// This function handles the server-side of the rpcstream protocol:
/// 1. Receives RpcStreamInit with component ID
/// 2. Looks up the invoker for that component
/// 3. Sends RpcAck (with error if not found)
/// 4. Handles nested RPC calls over the stream
///
/// # Arguments
/// * `stream` - The incoming RPC stream
/// * `getter` - Function to look up invokers by component ID
pub async fn handle_rpc_stream<S: RpcStream + Send + Sync + 'static>(
    stream: Arc<S>,
    getter: RpcStreamGetter,
) -> Result<()> {
    // Read the init packet
    let init_packet = stream.recv_packet().await?;
    let component_id = match init_packet.body {
        Some(rpc_stream_packet::Body::Init(init)) => init.component_id,
        _ => {
            return Err(Error::UnrecognizedPacket);
        }
    };

    let ctx = stream.context().child();

    // Look up the invoker
    let ctx_cancel = ctx.clone();
    let released = Box::new(move || {
        ctx_cancel.cancel();
    });

    let lookup_result = getter(&ctx, &component_id, released);

    // Send ack
    let (invoker, release_fn) = match lookup_result {
        Some((inv, rel)) => {
            // Send success ack
            stream
                .send_packet(&RpcStreamPacket::new_ack(String::new()))
                .await?;
            (inv, Some(rel))
        }
        None => {
            // Send error ack
            let err_msg = format!("no server for component: {}", component_id);
            stream
                .send_packet(&RpcStreamPacket::new_ack(err_msg.clone()))
                .await?;
            return Err(Error::Remote(err_msg));
        }
    };

    // Ensure release is called when we're done
    let _release_guard = scopeguard::guard(release_fn, |rel| {
        if let Some(f) = rel {
            f();
        }
    });

    // Create a writer for the RPC stream
    let writer: Arc<dyn PacketWriter> = Arc::new(RpcStreamWriter::new(stream.clone()));

    // Read and handle packets
    loop {
        let rpc_packet = match stream.recv_packet().await {
            Ok(p) => p,
            Err(Error::StreamClosed) => break,
            Err(e) => return Err(e),
        };

        let packet = match rpc_packet.body {
            Some(rpc_stream_packet::Body::Data(data)) => {
                match Packet::decode(&data[..]) {
                    Ok(p) => p,
                    Err(e) => return Err(Error::InvalidMessage(e)),
                }
            }
            _ => continue, // Ignore non-data packets
        };

        // Handle the packet based on its type
        use crate::proto::packet::Body;
        match packet.body {
            Some(Body::CallStart(call_start)) => {
                let rpc_ctx = ctx.child();
                let rpc = Arc::new(ServerRpc::from_call_start(
                    rpc_ctx,
                    call_start,
                    writer.clone(),
                ));

                let service_id = rpc.service().to_string();
                let method_id = rpc.method().to_string();

                // Spawn a task to handle this RPC
                let invoker_clone = invoker.clone();
                tokio::spawn(async move {
                    let (_found, _result) = invoker_clone
                        .invoke_method(&service_id, &method_id, Box::new(ServerRpcStream { rpc }))
                        .await;
                });
            }
            Some(Body::CallData(_)) | Some(Body::CallCancel(_)) => {
                // These should be routed to an existing RPC
                // In this simplified implementation, they're ignored
            }
            None => {}
        }
    }

    Ok(())
}

/// Wrapper to make ServerRpc implement Stream for use with invoke_method.
struct ServerRpcStream {
    rpc: Arc<ServerRpc>,
}

#[async_trait]
impl Stream for ServerRpcStream {
    fn context(&self) -> &Context {
        self.rpc.context()
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        crate::stream::Stream::send_bytes(self.rpc.as_ref(), data).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        crate::stream::Stream::recv_bytes(self.rpc.as_ref()).await
    }

    async fn close_send(&self) -> Result<()> {
        crate::stream::Stream::close_send(self.rpc.as_ref()).await
    }

    async fn close(&self) -> Result<()> {
        crate::stream::Stream::close(self.rpc.as_ref()).await
    }
}

/// Creates an OpenStream function using an RPC stream caller.
///
/// This allows creating a Client that operates over an RPC stream,
/// enabling nested RPC calls.
///
/// # Type Parameters
/// * `F` - Async function that creates a new stream
/// * `S` - Stream type
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

        // Create a channel for incoming packets
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        // Spawn a read pump to convert RpcStreamPacket::Data into Packets
        let stream_clone = rpc_stream.clone();
        tokio::spawn(async move {
            loop {
                match stream_clone.recv_packet().await {
                    Ok(packet) => {
                        if let Some(rpc_stream_packet::Body::Data(data)) = packet.body {
                            match Packet::decode(&data[..]) {
                                Ok(p) => {
                                    if tx.send(p).await.is_err() {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((writer, rx))
    }
}

/// Creates a Client that operates over an RPC stream.
///
/// # Arguments
/// * `caller` - Function that opens a new RPC stream
/// * `component_id` - Target component ID
/// * `wait_ack` - Whether to wait for acknowledgment
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Mutex;
    use std::collections::VecDeque;

    struct MockRpcStream {
        ctx: Context,
        send_queue: Mutex<VecDeque<RpcStreamPacket>>,
        recv_queue: Mutex<VecDeque<RpcStreamPacket>>,
        closed: AtomicBool,
    }

    impl MockRpcStream {
        fn new() -> Self {
            Self {
                ctx: Context::new(),
                send_queue: Mutex::new(VecDeque::new()),
                recv_queue: Mutex::new(VecDeque::new()),
                closed: AtomicBool::new(false),
            }
        }

        async fn push_recv(&self, packet: RpcStreamPacket) {
            self.recv_queue.lock().await.push_back(packet);
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
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
        }

        async fn close_send(&self) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
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
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
        }
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
