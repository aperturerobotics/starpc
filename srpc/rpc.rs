//! RPC state machines for client and server.
//!
//! This module provides the core RPC state machines that manage the lifecycle
//! of calls over the shared Go, TypeScript, and Rust wire protocol.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::{mpsc, Notify};

use crate::error::{Error, Result};
use crate::packet::{new_call_cancel, new_call_data_full, new_call_start, Validate};
use crate::proto::{packet::Body, CallData, CallStart, ErrorCode, Packet};
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
    local_completed: AtomicBool,

    /// Packet writer.
    writer: Arc<dyn PacketWriter>,

    /// Notification for state changes.
    notify: Notify,

    /// Bounded incoming data, shared by the packet reader and RPC consumer.
    data: mpsc::Sender<Bytes>,

    /// Internal state protected by mutex.
    state: Mutex<RpcState>,
}

/// Internal RPC state.
struct RpcState {
    /// Incoming messages, including empty payloads, retained until read.
    data: mpsc::Receiver<Bytes>,

    /// How the incoming side ended, once it has.
    end: Option<RpcEnd>,
}

/// How the incoming side of an RPC ended.
enum RpcEnd {
    /// The remote completed the call, or the local side closed it.
    Complete,

    /// The remote failed or cancelled the call.
    Remote(String),

    /// The transport closed without a remote completion or error.
    ClosedBeforeCompletion,

    /// The forwarded transport was reset.
    Reset,
}

impl RpcEnd {
    /// Returns the error a read reports after the queued messages.
    fn error(&self) -> Error {
        match self {
            RpcEnd::Complete => Error::StreamClosed,
            RpcEnd::Remote(err) => Error::Remote(err.clone()),
            RpcEnd::ClosedBeforeCompletion => Error::ClosedBeforeCompletion,
            RpcEnd::Reset => Error::Reset,
        }
    }
}

impl CommonRpc {
    /// Creates a new CommonRpc.
    pub fn new(
        ctx: Context,
        service: String,
        method: String,
        writer: Arc<dyn PacketWriter>,
    ) -> Self {
        // Retain one unread message; the packet reader waits before accepting another.
        let (data, receiver) = mpsc::channel(1);
        Self {
            ctx,
            service,
            method,
            local_completed: AtomicBool::new(false),
            writer,
            notify: Notify::new(),
            data,
            state: Mutex::new(RpcState {
                data: receiver,
                end: None,
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

    /// Waits for the remote verdict after preceding payloads have been accepted.
    ///
    /// Streaming consumers must receive data concurrently so the packet reader
    /// can reach completion beyond a full receive channel.
    pub async fn wait(&self) -> Result<()> {
        loop {
            // Capture the notification before reading state so a concurrent
            // completion cannot fall between the check and the wait.
            let changed = self.notify.notified();
            // Check current state
            {
                let state = self.state.lock().unwrap();

                // Check cancellation first - local cancellation takes priority
                if self.ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }

                match state.end {
                    Some(RpcEnd::Complete) => return Ok(()),
                    Some(ref end) => return Err(end.error()),
                    None => {}
                }
            }

            // Wait for notification or cancellation
            tokio::select! {
                _ = changed => continue,
                _ = self.ctx.cancelled() => return Err(Error::Cancelled),
            }
        }
    }

    /// Reads one message from the data queue, blocking until available.
    ///
    /// After the queued messages, returns `Err(Error::StreamClosed)` if the
    /// call completed, matching `io.EOF` in the Go implementation, or the
    /// error that ended it.
    pub async fn read_one(&self) -> Result<Bytes> {
        loop {
            // notify_waiters preserves notifications from this future's creation.
            let changed = self.notify.notified();
            // Try to get a message from the queue first, before checking cancellation.
            // This ensures we drain any pending messages even if the context is cancelled.
            {
                let mut state = self.state.lock().unwrap();

                if let Ok(data) = state.data.try_recv() {
                    return Ok(data);
                }

                if let Some(ref end) = state.end {
                    return Err(end.error());
                }
            }

            // Now check for cancellation - only if no data is available
            // and the stream isn't properly closed.
            if self.ctx.is_cancelled() {
                // Settle cancellation before releasing the writer outside the lock.
                let close = {
                    let mut state = self.state.lock().unwrap();
                    if state.end.is_none() {
                        state.end = Some(RpcEnd::Complete);
                        state.data.close();
                        true
                    } else {
                        false
                    }
                };
                if close {
                    // Cancellation determines the result even if transport close fails.
                    let _ = self.writer.close().await;
                    self.ctx.cancel();
                    self.notify.notify_waiters();
                }
                return Err(Error::Cancelled);
            }

            // Wait for notification or cancellation
            tokio::select! {
                _ = changed => continue,
                _ = self.ctx.cancelled() => {
                    // Loop will handle the cancellation
                    continue;
                }
            }
        }
    }

    /// Writes a CallData packet, completing the call when either `complete`
    /// or `error` is set. Returns `Error::Completed` once the call has
    /// already completed locally.
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

    /// Accepts incoming data, waiting for the consumer when one message is unread.
    ///
    /// The transport reader retains at most one further packet while waiting.
    /// Cancellation or closing the RPC releases a blocked packet reader. Completion
    /// remains ordered after its data, and control-only packets need no capacity.
    pub async fn handle_call_data(&self, call_data: CallData) -> Result<()> {
        // Reserve capacity without holding the state lock needed by the consumer.
        let pending =
            if let Some(data) = decode_optional_data(call_data.data, call_data.data_is_zero) {
                let result = tokio::select! {
                    biased;
                    result = self.data.reserve() => result,
                    () = self.ctx.cancelled() => return Err(Error::Cancelled),
                };
                match result {
                    Ok(permit) => Some((data, permit)),
                    Err(_) if call_data.complete => return Ok(()),
                    Err(_) => return Err(Error::Completed),
                }
            } else {
                None
            };

        // Closing and packet delivery share the lock, so no data arrives after an end.
        let mut state = self.state.lock().unwrap();
        if state.end.is_some() {
            return if call_data.complete {
                Ok(())
            } else {
                Err(Error::Completed)
            };
        }
        if let Some((data, permit)) = pending {
            permit.send(data);
        }

        // Publish the terminal verdict after its final payload and wake blocked readers.
        if call_data.error_code != ErrorCode::Unknown as i32 || !call_data.error.is_empty() {
            state.end = Some(
                match ErrorCode::try_from(call_data.error_code).unwrap_or(ErrorCode::Unknown) {
                    ErrorCode::Reset => RpcEnd::Reset,
                    ErrorCode::ClosedBeforeCompletion => RpcEnd::ClosedBeforeCompletion,
                    ErrorCode::Unknown => RpcEnd::Remote(call_data.error),
                },
            );
        } else if call_data.complete {
            state.end = Some(RpcEnd::Complete);
        }
        if state.end.is_some() {
            state.data.close();
        }
        drop(state);
        self.notify.notify_waiters();

        Ok(())
    }

    /// Handles a CallCancel packet.
    pub async fn handle_call_cancel(&self) -> Result<()> {
        self.handle_stream_close(Some("cancelled".to_string()))
            .await
    }

    /// Handles stream close from the transport.
    ///
    /// A clean close with no completion behind it leaves the call without a
    /// verdict, so reads report `Error::ClosedBeforeCompletion` rather than the
    /// clean end of the stream.
    pub async fn handle_stream_close(&self, err: Option<String>) -> Result<()> {
        // Preserve a verdict already received and release blocked packet producers.
        {
            let mut state = self.state.lock().unwrap();
            if state.end.is_none() {
                state.end = Some(match err {
                    Some(err) => RpcEnd::Remote(err),
                    None => RpcEnd::ClosedBeforeCompletion,
                });
            }
            state.data.close();
        }

        // The incoming verdict determines reads even if closing the writer fails.
        let _ = self.writer.close().await;
        self.ctx.cancel();
        self.notify.notify_waiters();

        Ok(())
    }

    /// Ends the call locally and releases its resources.
    ///
    /// A call with no verdict ends as complete, pending waiters and reads
    /// wake, and the writer closes before the context cancels. Returns the
    /// writer's close error; every caller still finds the call ended.
    async fn close_local(&self) -> Result<()> {
        // End data reception and release packet producers before transport shutdown.
        {
            let mut state = self.state.lock().unwrap();
            if state.end.is_none() {
                state.end = Some(RpcEnd::Complete);
            }
            self.local_completed.store(true, Ordering::SeqCst);
            state.data.close();
        }

        // Wake observers even when the writer fails to close.
        let closed = self.writer.close().await;
        self.notify.notify_waiters();
        self.ctx.cancel();

        closed
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

    /// Waits for the remote verdict; receive streaming payloads concurrently.
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
        let _ = self.common.close_local().await;
    }
}

#[async_trait]
impl Stream for ClientRpc {
    fn context(&self) -> &Context {
        &self.common.ctx
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        self.common.write_call_data(Some(data), false, None).await
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

    /// Waits for the remote verdict; receive streaming payloads concurrently.
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

    /// Sends a typed transport failure without converting it to a handler verdict.
    pub async fn send_transport_error(&self, err: &Error) -> Result<()> {
        // Preserve the transport classification in the generated packet.
        let code = match err {
            Error::Reset => ErrorCode::Reset,
            Error::ClosedBeforeCompletion => ErrorCode::ClosedBeforeCompletion,
            _ => ErrorCode::Unknown,
        };
        let mut packet = new_call_data_full(None, true, Some(err.to_string()));
        if let Some(Body::CallData(data)) = packet.body.as_mut() {
            data.error_code = code as i32;
        }

        // Publish the failure before closing this RPC's writer.
        self.common.local_completed.store(true, Ordering::SeqCst);
        self.common.writer.write_packet(packet).await
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
        self.common.write_call_data(Some(data), false, None).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        // First check for initial data
        {
            let mut initial = self.initial_data.lock().unwrap();
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
        self.common.close_local().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    /// Records outgoing packets and whether the transport was closed.
    struct MockWriter {
        /// Packets written in order.
        packets: StdMutex<Vec<Packet>>,
        /// Whether close has run.
        closed: AtomicBool,
    }

    impl MockWriter {
        /// Creates an open writer with no packets.
        fn new() -> Self {
            Self {
                packets: StdMutex::new(Vec::new()),
                closed: AtomicBool::new(false),
            }
        }

        /// Copies the recorded wire packets.
        fn packets(&self) -> Vec<Packet> {
            self.packets.lock().unwrap().clone()
        }

        /// Reports transport closure.
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

    /// Starting a call transmits its service, method, and initial data.
    #[tokio::test]
    async fn test_client_rpc_start() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(
            ctx,
            "test.Service".into(),
            "TestMethod".into(),
            writer.clone(),
        );

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

    /// A client call sends its start packet once.
    #[tokio::test]
    async fn test_client_rpc_double_start_fails() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(ctx, "test.Service".into(), "TestMethod".into(), writer);

        rpc.start(None).await.unwrap();
        let result = rpc.start(None).await;
        assert!(matches!(result, Err(Error::Completed)));
    }

    /// Closing a started call sends cancellation and closes the transport.
    #[tokio::test]
    async fn test_client_rpc_close_sends_cancel() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = ClientRpc::new(
            ctx,
            "test.Service".into(),
            "TestMethod".into(),
            writer.clone(),
        );

        rpc.start(None).await.unwrap();
        rpc.close().await;

        let packets = writer.packets();
        assert_eq!(packets.len(), 2);

        // Second packet should be CallCancel
        assert!(packets[1].is_call_cancel());
        assert!(writer.is_closed());
    }

    /// A server delivers the initial payload before subsequent data.
    #[tokio::test]
    async fn test_server_rpc_from_call_start() {
        // Establish the call and its transport recorder.
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

    /// Local closure rejects data arriving after the call ends.
    #[tokio::test]
    async fn test_server_rpc_close_ends_the_call() {
        // Establish the call and its transport recorder.
        let call_start = CallStart {
            rpc_service: "test.Service".into(),
            rpc_method: "TestMethod".into(),
            data: Vec::new(),
            data_is_zero: false,
        };
        let writer = Arc::new(MockWriter::new());
        let rpc = ServerRpc::from_call_start(Context::new(), call_start, writer.clone());

        // Closing releases the writer and cancels the call.
        rpc.close().await.unwrap();
        assert!(writer.is_closed());
        assert!(rpc.context().is_cancelled());

        // The call has an end state, so later data is refused instead of queued.
        let late = CallData {
            data: vec![1],
            ..Default::default()
        };
        let result = rpc.common.handle_call_data(late).await;
        assert!(matches!(result, Err(Error::Completed)));
    }

    /// Receiving preserves payload bytes.
    #[tokio::test]
    async fn test_common_rpc_read_one_with_data() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate receiving data
        let call_data = CallData {
            data: vec![1, 2, 3],
            data_is_zero: false,
            complete: false,
            error: String::new(),
            error_code: 0,
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let data = rpc.read_one().await.unwrap();
        assert_eq!(&data[..], &[1, 2, 3]);
    }

    /// Completion without data ends reads cleanly.
    #[tokio::test]
    async fn test_common_rpc_read_one_stream_closed() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate stream close
        let call_data = CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: String::new(),
            error_code: 0,
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let result = rpc.read_one().await;
        assert!(matches!(result, Err(Error::StreamClosed)));
    }

    /// A remote failure preserves its error text.
    #[tokio::test]
    async fn test_common_rpc_read_one_with_error() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Simulate error
        let call_data = CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: "test error".into(),
            error_code: 0,
        };
        rpc.handle_call_data(call_data).await.unwrap();

        let result = rpc.read_one().await;
        match result {
            Err(Error::Remote(msg)) => assert_eq!(msg, "test error"),
            _ => panic!("expected Remote error"),
        }
    }

    /// A forwarded transport verdict retains its classification.
    #[tokio::test]
    async fn forwarded_transport_error_is_typed() {
        for code in [ErrorCode::Reset, ErrorCode::ClosedBeforeCompletion] {
            let rpc = CommonRpc::new(
                Context::new(),
                "svc".into(),
                "method".into(),
                Arc::new(MockWriter::new()),
            );
            rpc.handle_call_data(CallData {
                complete: true,
                error: "original diagnostic".into(),
                error_code: code as i32,
                ..Default::default()
            })
            .await
            .unwrap();
            let err = rpc.read_one().await.unwrap_err();
            match code {
                ErrorCode::Reset => assert!(matches!(err, Error::Reset)),
                ErrorCode::ClosedBeforeCompletion => {
                    assert!(matches!(err, Error::ClosedBeforeCompletion))
                }
                ErrorCode::Unknown => unreachable!(),
            }
        }
    }

    /// Local completion rejects subsequent data writes.
    #[tokio::test]
    async fn test_write_call_data_after_complete() {
        // Establish the call and its transport recorder.
        let writer = Arc::new(MockWriter::new());
        let ctx = Context::new();
        let rpc = CommonRpc::new(ctx, "svc".into(), "method".into(), writer);

        // Complete the RPC
        rpc.write_call_data(None, true, None).await.unwrap();

        // Trying to send more data should fail
        let result = rpc
            .write_call_data(Some(Bytes::from(vec![1])), false, None)
            .await;
        assert!(matches!(result, Err(Error::Completed)));
    }

    /// Cancellation sends exactly one wire packet.
    #[tokio::test]
    async fn test_write_call_cancel() {
        // Establish the call and its transport recorder.
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

    /// A full receive channel pauses packet processing until the consumer reads.
    #[tokio::test]
    async fn receive_capacity_preserves_data_and_terminal_order() {
        // Fill the receive channel with an empty but present message.
        let rpc = CommonRpc::new(
            Context::new(),
            "svc".into(),
            "method".into(),
            Arc::new(MockWriter::new()),
        );
        rpc.handle_call_data(CallData {
            data_is_zero: true,
            ..Default::default()
        })
        .await
        .unwrap();

        // The final payload waits for capacity without publishing completion early.
        let final_packet = rpc.handle_call_data(CallData {
            data: b"last".to_vec(),
            complete: true,
            error: "finished".into(),
            ..Default::default()
        });
        tokio::pin!(final_packet);
        assert!(futures::poll!(&mut final_packet).is_pending());
        let wait = rpc.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());

        // Draining the prior message admits the final payload before its error.
        assert!(rpc.read_one().await.unwrap().is_empty());
        final_packet.await.unwrap();
        assert_eq!(rpc.read_one().await.unwrap().as_ref(), b"last");
        assert!(matches!(rpc.read_one().await, Err(Error::Remote(err)) if err == "finished"));
        assert!(matches!(wait.await, Err(Error::Remote(err)) if err == "finished"));
    }

    /// Cancellation and closure both wake a packet reader waiting for capacity.
    #[tokio::test]
    async fn full_receive_channel_releases_on_cancel_and_close() {
        // Exercise context cancellation, local close, and transport loss separately.
        for end in 0..3 {
            let rpc = CommonRpc::new(
                Context::new(),
                "svc".into(),
                "method".into(),
                Arc::new(MockWriter::new()),
            );
            rpc.handle_call_data(CallData {
                data: vec![1],
                ..Default::default()
            })
            .await
            .unwrap();
            let pending = rpc.handle_call_data(CallData {
                data: vec![2],
                ..Default::default()
            });
            tokio::pin!(pending);
            assert!(futures::poll!(&mut pending).is_pending());

            // End the RPC through its public lifetime operation while data remains unread.
            match end {
                0 => rpc.context().cancel(),
                1 => rpc.close_local().await.unwrap(),
                _ => rpc.handle_stream_close(None).await.unwrap(),
            }
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
                .await
                .unwrap();
            assert!(matches!(result, Err(Error::Cancelled | Error::Completed)));
            assert_eq!(rpc.read_one().await.unwrap().as_ref(), &[1]);
            assert!(rpc.read_one().await.is_err());
        }
    }

    /// A completion with no payload bypasses a full data channel.
    #[tokio::test]
    async fn completion_does_not_need_receive_capacity() {
        // Leave one unread payload when the peer completes the stream.
        let rpc = CommonRpc::new(
            Context::new(),
            "svc".into(),
            "method".into(),
            Arc::new(MockWriter::new()),
        );
        rpc.handle_call_data(CallData {
            data: vec![1],
            ..Default::default()
        })
        .await
        .unwrap();
        rpc.handle_call_data(CallData {
            complete: true,
            ..Default::default()
        })
        .await
        .unwrap();

        // Wait observes completion, while receive preserves the payload preceding it.
        rpc.wait().await.unwrap();
        assert_eq!(rpc.read_one().await.unwrap().as_ref(), &[1]);
        assert!(matches!(rpc.read_one().await, Err(Error::StreamClosed)));
    }
}
