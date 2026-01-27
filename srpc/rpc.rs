//! RPC state machines for client and server.
//!
//! This module provides the core RPC state machines that manage the lifecycle
//! of RPC calls, matching the behavior of the Go and TypeScript implementations.

use async_trait::async_trait;
use bytes::Bytes;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

use crate::error::{Error, Result};
use crate::packet::{new_call_cancel, new_call_data_full, new_call_start, Validate};
use crate::proto::{packet::Body, CallData, CallStart, Packet};
use crate::stream::{Context, Stream};
use crate::transport::decode_optional_data;

/// Trait for writing packets to the transport.
#[async_trait]
pub trait PacketWriter: Send + Sync {
    /// Writes a packet to the transport.
    async fn write_packet(&self, packet: Packet) -> Result<()>;

    /// Closes the writer.
    async fn close(&self) -> Result<()>;
}

/// Common RPC state shared between client and server.
///
/// This struct manages the state machine for an RPC call, including:
/// - Message queuing and delivery
/// - Completion tracking
/// - Error handling
/// - Cancellation
pub struct CommonRpc {
    /// Context for this RPC.
    ctx: Context,

    /// Service identifier.
    service: String,

    /// Method identifier.
    method: String,

    /// Whether we have completed locally (sent complete/cancel).
    /// Note: not guarded by the mutex, uses atomic operations.
    local_completed: AtomicBool,

    /// Packet writer.
    writer: Arc<dyn PacketWriter>,

    /// Notification for state changes.
    notify: Notify,

    /// Internal state protected by mutex.
    state: Mutex<RpcState>,
}

/// Internal RPC state.
struct RpcState {
    /// Queue of incoming data messages.
    /// Note: messages may be len() == 0 (empty data with data_is_zero).
    data_queue: VecDeque<Bytes>,

    /// Whether the remote side has closed the stream.
    data_closed: bool,

    /// Error from the remote side, if any.
    remote_err: Option<String>,
}

impl CommonRpc {
    /// Creates a new CommonRpc.
    pub fn new(
        ctx: Context,
        service: String,
        method: String,
        writer: Arc<dyn PacketWriter>,
    ) -> Self {
        Self {
            ctx,
            service,
            method,
            local_completed: AtomicBool::new(false),
            writer,
            notify: Notify::new(),
            state: Mutex::new(RpcState {
                data_queue: VecDeque::new(),
                data_closed: false,
                remote_err: None,
            }),
        }
    }

    /// Returns the context for this RPC.
    pub fn context(&self) -> &Context {
        &self.ctx
    }

    /// Returns the service ID.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// Returns the method ID.
    pub fn method(&self) -> &str {
        &self.method
    }

    /// Returns true if the RPC has completed locally.
    pub fn is_local_completed(&self) -> bool {
        self.local_completed.load(Ordering::SeqCst)
    }

    /// Waits for the RPC to finish (remote end closed the stream).
    ///
    /// This matches the Go implementation's `Wait(ctx context.Context) error`.
    pub async fn wait(&self) -> Result<()> {
        loop {
            // Check current state
            {
                let state = self.state.lock().await;

                if let Some(ref err) = state.remote_err {
                    return Err(Error::Remote(err.clone()));
                }

                if self.ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }

                if state.data_closed {
                    return Ok(());
                }
            }

            // Wait for notification or cancellation
            tokio::select! {
                _ = self.notify.notified() => continue,
                _ = self.ctx.cancelled() => return Err(Error::Cancelled),
            }
        }
    }

    /// Reads one message from the data queue, blocking until available.
    ///
    /// Returns `Err(Error::StreamClosed)` if the stream ended without a packet.
    /// This matches the Go implementation which returns `io.EOF`.
    pub async fn read_one(&self) -> Result<Bytes> {
        loop {
            // Check for cancellation first
            if self.ctx.is_cancelled() {
                // If context cancelled and data not closed, close it now
                let mut state = self.state.lock().await;
                if !state.data_closed {
                    state.data_closed = true;
                    if state.remote_err.is_none() {
                        state.remote_err = Some("context cancelled".to_string());
                    }
                    drop(state);
                    let _ = self.writer.close().await;
                    self.ctx.cancel();
                    self.notify.notify_waiters();
                }
                return Err(Error::Cancelled);
            }

            // Try to get a message from the queue
            {
                let mut state = self.state.lock().await;

                if let Some(data) = state.data_queue.pop_front() {
                    return Ok(data);
                }

                // Check if the stream is closed
                if state.data_closed {
                    if let Some(ref err) = state.remote_err {
                        return Err(Error::Remote(err.clone()));
                    }
                    return Err(Error::StreamClosed);
                }
            }

            // Wait for notification or cancellation
            tokio::select! {
                _ = self.notify.notified() => continue,
                _ = self.ctx.cancelled() => {
                    // Loop will handle the cancellation
                    continue;
                }
            }
        }
    }

    /// Writes a CallData packet.
    ///
    /// # Arguments
    /// * `data` - Optional data to send
    /// * `complete` - Whether this completes the RPC
    /// * `error` - Optional error message
    pub async fn write_call_data(
        &self,
        data: Option<Bytes>,
        complete: bool,
        error: Option<String>,
    ) -> Result<()> {
        let should_complete = complete || error.is_some();

        // Check if already completed
        if should_complete {
            if self
                .local_completed
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                // If we're just marking completion and already completed, allow it (no-op)
                // This matches Go behavior
                if complete && data.is_none() && error.is_none() {
                    return Ok(());
                }
                return Err(Error::Completed);
            }
        } else if self.local_completed.load(Ordering::SeqCst) {
            return Err(Error::Completed);
        }

        let packet = new_call_data_full(data, complete, error);
        self.writer.write_packet(packet).await
    }

    /// Writes a CallCancel packet.
    ///
    /// This atomically checks and sets the completed flag, then sends the cancel.
    pub async fn write_call_cancel(&self) -> Result<()> {
        // Use atomic swap to check and set completion atomically
        if self.local_completed.swap(true, Ordering::SeqCst) {
            return Err(Error::Completed);
        }

        self.writer.write_packet(new_call_cancel()).await
    }

    /// Handles an incoming CallData packet.
    pub async fn handle_call_data(&self, call_data: CallData) -> Result<()> {
        let mut state = self.state.lock().await;

        // Check if already closed
        if state.data_closed {
            // If the packet is just indicating the call is complete, ignore it
            // This matches Go behavior
            if call_data.complete {
                return Ok(());
            }
            return Err(Error::Completed);
        }

        // Extract data if present
        if let Some(data) = decode_optional_data(call_data.data, call_data.data_is_zero) {
            state.data_queue.push_back(data);
        }

        // Handle completion or error
        if !call_data.error.is_empty() {
            state.remote_err = Some(call_data.error);
            state.data_closed = true;
        } else if call_data.complete {
            state.data_closed = true;
        }

        // Notify waiters
        drop(state);
        self.notify.notify_waiters();

        Ok(())
    }

    /// Handles a CallCancel packet.
    pub async fn handle_call_cancel(&self) -> Result<()> {
        self.handle_stream_close(Some("cancelled".to_string())).await
    }

    /// Handles stream close from the transport.
    pub async fn handle_stream_close(&self, err: Option<String>) -> Result<()> {
        let mut state = self.state.lock().await;

        if let Some(e) = err {
            if state.remote_err.is_none() {
                state.remote_err = Some(e);
            }
        }
        state.data_closed = true;

        drop(state);

        let _ = self.writer.close().await;
        self.ctx.cancel();
        self.notify.notify_waiters();

        Ok(())
    }

    /// Closes the RPC, releasing resources.
    ///
    /// This is called internally and handles cleanup.
    async fn close_locked(&self) {
        let mut state = self.state.lock().await;
        state.data_closed = true;
        self.local_completed.store(true, Ordering::SeqCst);
        if state.remote_err.is_none() {
            state.remote_err = Some("cancelled".to_string());
        }
        drop(state);

        let _ = self.writer.close().await;
        self.notify.notify_waiters();
        self.ctx.cancel();
    }
}

/// Client-side RPC state machine.
pub struct ClientRpc {
    common: CommonRpc,
    /// Whether CallStart has been sent.
    start_sent: AtomicBool,
}

impl ClientRpc {
    /// Creates a new ClientRpc.
    pub fn new(
        ctx: Context,
        service: String,
        method: String,
        writer: Arc<dyn PacketWriter>,
    ) -> Self {
        Self {
            common: CommonRpc::new(ctx, service, method, writer),
            start_sent: AtomicBool::new(false),
        }
    }

    /// Returns the context for this RPC.
    pub fn context(&self) -> &Context {
        self.common.context()
    }

    /// Returns the service ID.
    pub fn service(&self) -> &str {
        self.common.service()
    }

    /// Returns the method ID.
    pub fn method(&self) -> &str {
        self.common.method()
    }

    /// Waits for the RPC to finish.
    pub async fn wait(&self) -> Result<()> {
        self.common.wait().await
    }

    /// Starts the RPC call with optional initial data.
    pub async fn start(&self, data: Option<Bytes>) -> Result<()> {
        if self
            .start_sent
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::Completed);
        }

        // Check context before starting
        if self.common.ctx.is_cancelled() {
            self.common.ctx.cancel();
            let _ = self.common.writer.close().await;
            return Err(Error::Cancelled);
        }

        let packet = new_call_start(
            self.common.service.clone(),
            self.common.method.clone(),
            data,
        );

        if let Err(e) = self.common.writer.write_packet(packet).await {
            self.common.ctx.cancel();
            let _ = self.common.writer.close().await;
            return Err(e);
        }

        Ok(())
    }

    /// Handles an incoming packet.
    pub async fn handle_packet(&self, packet: Packet) -> Result<()> {
        // Validate the packet first
        packet.validate()?;

        match packet.body {
            Some(Body::CallData(call_data)) => self.common.handle_call_data(call_data).await,
            Some(Body::CallCancel(true)) => self.common.handle_call_cancel().await,
            Some(Body::CallCancel(false)) => Ok(()),
            Some(Body::CallStart(_)) => {
                // Server-to-client calls not supported
                Err(Error::UnrecognizedPacket)
            }
            None => Err(Error::EmptyPacket),
        }
    }

    /// Handles stream close from the transport.
    pub async fn handle_stream_close(&self, err: Option<String>) -> Result<()> {
        self.common.handle_stream_close(err).await
    }

    /// Closes the client RPC.
    ///
    /// This sends a cancel packet (if not already completed) and releases resources.
    /// Matches the Go implementation's `Close()` behavior.
    pub async fn close(&self) {
        // Only proceed if writer was set (start was called)
        if !self.start_sent.load(Ordering::SeqCst) {
            return;
        }

        // Try to send cancel, ignore errors
        let _ = self.common.write_call_cancel().await;

        // Close resources
        self.common.close_locked().await;
    }
}

#[async_trait]
impl Stream for ClientRpc {
    fn context(&self) -> &Context {
        &self.common.ctx
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        self.common
            .write_call_data(Some(data), false, None)
            .await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        self.common.read_one().await
    }

    async fn close_send(&self) -> Result<()> {
        self.common.write_call_data(None, true, None).await
    }

    async fn close(&self) -> Result<()> {
        ClientRpc::close(self).await;
        Ok(())
    }
}

/// Server-side RPC state machine.
pub struct ServerRpc {
    common: CommonRpc,
    /// Initial data from CallStart, if any.
    initial_data: Mutex<Option<Bytes>>,
}

impl ServerRpc {
    /// Creates a new ServerRpc from a CallStart packet.
    pub fn from_call_start(
        ctx: Context,
        call_start: CallStart,
        writer: Arc<dyn PacketWriter>,
    ) -> Self {
        let initial_data = decode_optional_data(call_start.data, call_start.data_is_zero);

        Self {
            common: CommonRpc::new(ctx, call_start.rpc_service, call_start.rpc_method, writer),
            initial_data: Mutex::new(initial_data),
        }
    }

    /// Returns the context for this RPC.
    pub fn context(&self) -> &Context {
        self.common.context()
    }

    /// Returns the service ID.
    pub fn service(&self) -> &str {
        self.common.service()
    }

    /// Returns the method ID.
    pub fn method(&self) -> &str {
        self.common.method()
    }

    /// Waits for the RPC to finish.
    pub async fn wait(&self) -> Result<()> {
        self.common.wait().await
    }

    /// Handles an incoming packet.
    pub async fn handle_packet(&self, packet: Packet) -> Result<()> {
        // Validate the packet first
        packet.validate()?;

        match packet.body {
            Some(Body::CallData(call_data)) => self.common.handle_call_data(call_data).await,
            Some(Body::CallCancel(true)) => self.common.handle_call_cancel().await,
            Some(Body::CallCancel(false)) => Ok(()),
            Some(Body::CallStart(_)) => {
                // CallStart should only be sent once
                Err(Error::DuplicateCallStart)
            }
            None => Err(Error::EmptyPacket),
        }
    }

    /// Handles stream close from the transport.
    pub async fn handle_stream_close(&self, err: Option<String>) -> Result<()> {
        self.common.handle_stream_close(err).await
    }

    /// Sends an error response and closes.
    pub async fn send_error(&self, error: String) -> Result<()> {
        self.common.write_call_data(None, true, Some(error)).await
    }
}

#[async_trait]
impl Stream for ServerRpc {
    fn context(&self) -> &Context {
        &self.common.ctx
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        self.common
            .write_call_data(Some(data), false, None)
            .await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        // First check for initial data
        {
            let mut initial = self.initial_data.lock().await;
            if let Some(data) = initial.take() {
                return Ok(data);
            }
        }

        // Then read from the queue
        self.common.read_one().await
    }

    async fn close_send(&self) -> Result<()> {
        self.common.write_call_data(None, true, None).await
    }

    async fn close(&self) -> Result<()> {
        // Mark as locally completed
        self.common.local_completed.store(true, Ordering::SeqCst);

        // Close the writer
        self.common.writer.close().await?;

        // Cancel the context
        self.common.ctx.cancel();

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Mock packet writer for testing.
    struct MockWriter {
        packets: StdMutex<Vec<Packet>>,
        closed: AtomicBool,
    }

    impl MockWriter {
        fn new() -> Self {
            Self {
                packets: StdMutex::new(Vec::new()),
                closed: AtomicBool::new(false),
            }
        }

        fn packets(&self) -> Vec<Packet> {
            self.packets.lock().unwrap().clone()
        }

        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl PacketWriter for MockWriter {
        async fn write_packet(&self, packet: Packet) -> Result<()> {
            self.packets.lock().unwrap().push(packet);
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_client_rpc_start() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(ctx, "test.Service".into(), "TestMethod".into(), writer.clone());

        rpc.start(Some(Bytes::from(vec![1, 2, 3]))).await.unwrap();

        let packets = writer.packets();
        assert_eq!(packets.len(), 1);

        match &packets[0].body {
            Some(Body::CallStart(cs)) => {
                assert_eq!(cs.rpc_service, "test.Service");
                assert_eq!(cs.rpc_method, "TestMethod");
                assert_eq!(cs.data, vec![1, 2, 3]);
                assert!(!cs.data_is_zero);
            }
            _ => panic!("expected CallStart"),
        }
    }

    #[tokio::test]
    async fn test_client_rpc_double_start_fails() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(ctx, "test.Service".into(), "TestMethod".into(), writer);

        rpc.start(None).await.unwrap();
        let result = rpc.start(None).await;
        assert!(matches!(result, Err(Error::Completed)));
    }

    #[tokio::test]
    async fn test_client_rpc_close_sends_cancel() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(ctx, "test.Service".into(), "TestMethod".into(), writer.clone());

        rpc.start(None).await.unwrap();
        rpc.close().await;

        let packets = writer.packets();
        assert_eq!(packets.len(), 2);

        // Second packet should be CallCancel
        assert!(packets[1].is_call_cancel());
        assert!(writer.is_closed());
    }

    #[tokio::test]
    async fn test_server_rpc_from_call_start() {
        let call_start = CallStart {
            rpc_service: "test.Service".into(),
            rpc_method: "TestMethod".into(),
            data: vec![1, 2, 3],
            data_is_zero: false,
        };

        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ServerRpc::from_call_start(ctx, call_start, writer);

        assert_eq!(rpc.service(), "test.Service");
        assert_eq!(rpc.method(), "TestMethod");

        // First recv should return the initial data
        let data = rpc.recv_bytes().await.unwrap();
        assert_eq!(&data[..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn test_common_rpc_read_one_with_data() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate receiving data
        let call_data = CallData {
            data: vec![1, 2, 3],
            data_is_zero: false,
            complete: false,
            error: String::new(),
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let data = rpc.read_one().await.unwrap();
        assert_eq!(&data[..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn test_common_rpc_read_one_stream_closed() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate stream close
        let call_data = CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: String::new(),
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let result = rpc.read_one().await;
        assert!(matches!(result, Err(Error::StreamClosed)));
    }

    #[tokio::test]
    async fn test_common_rpc_read_one_with_error() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate error
        let call_data = CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: "test error".into(),
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let result = rpc.read_one().await;
        match result {
            Err(Error::Remote(msg)) => assert_eq!(msg, "test error"),
            _ => panic!("expected Remote error"),
        }
    }

    #[tokio::test]
    async fn test_write_call_data_after_complete() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Complete the RPC
        rpc.write_call_data(None, true, None).await.unwrap();

        // Trying to send more data should fail
        let result = rpc.write_call_data(Some(Bytes::from(vec![1])), false, None).await;
        assert!(matches!(result, Err(Error::Completed)));
    }

    #[tokio::test]
    async fn test_write_call_cancel() {
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer.clone());

        rpc.write_call_cancel().await.unwrap();

        let packets = writer.packets();
        assert_eq!(packets.len(), 1);
        assert!(packets[0].is_call_cancel());

        // Second cancel should fail
        let result = rpc.write_call_cancel().await;
        assert!(matches!(result, Err(Error::Completed)));
    }
}
