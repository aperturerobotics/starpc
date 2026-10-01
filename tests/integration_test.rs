//! Integration tests for starpc, mirroring the Go/JS test patterns.
//!
//! These tests verify:
//! 1. Unary RPC
//! 2. Server streaming (5 messages)
//! 3. Client streaming
//! 4. Bidirectional streaming
//! 5. Error handling
//! 6. Wire format compatibility

use async_trait::async_trait;
use prost::Message;
use std::sync::Arc;
use std::time::Duration;

use starpc::error::{Error, Result};
use starpc::handler::Handler;
use starpc::invoker::Invoker;
use starpc::mux::Mux;
use starpc::server::Server;
use starpc::stream::{Stream, StreamExt};
use starpc::testing::{create_test_pair, SingleInMemoryOpener};
use starpc::Client;

// Simple EchoMsg for testing
#[derive(Clone, PartialEq, Message)]
struct EchoMsg {
    #[prost(string, tag = "1")]
    body: String,
}

const BODY_TXT: &str = "hello world via starpc e2e test";

/// Echo server implementation matching Go's echo/server.go
struct EchoServer;

#[async_trait]
impl Invoker for EchoServer {
    async fn invoke_method(
        &self,
        _service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        match method_id {
            "Echo" => (true, self.echo(stream).await),
            "EchoServerStream" => (true, self.echo_server_stream(stream).await),
            "EchoClientStream" => (true, self.echo_client_stream(stream).await),
            "EchoBidiStream" => (true, self.echo_bidi_stream(stream).await),
            _ => (false, Err(Error::Unimplemented)),
        }
    }
}

impl Handler for EchoServer {
    fn service_id(&self) -> &'static str {
        "echo.Echoer"
    }

    fn method_ids(&self) -> &'static [&'static str] {
        &[
            "Echo",
            "EchoServerStream",
            "EchoClientStream",
            "EchoBidiStream",
        ]
    }
}

impl EchoServer {
    /// Unary echo - returns the same message
    async fn echo(&self, stream: Box<dyn Stream>) -> Result<()> {
        let msg: EchoMsg = stream.msg_recv().await?;
        stream.msg_send(&msg).await?;
        Ok(())
    }

    /// Server streaming - sends 5 copies of the message
    async fn echo_server_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        let msg: EchoMsg = stream.msg_recv().await?;

        // Send 5 responses with delays
        for _ in 0..5 {
            if stream.context().is_cancelled() {
                return Err(Error::Cancelled);
            }
            stream.msg_send(&msg).await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }

    /// Client streaming - returns first message received
    async fn echo_client_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        let msg: EchoMsg = stream.msg_recv().await?;
        stream.msg_send(&msg).await?;
        Ok(())
    }

    /// Bidirectional streaming - server sends first, then echoes all messages
    async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        // Server sends initial message
        let initial = EchoMsg {
            body: "hello from server".to_string(),
        };
        stream.msg_send(&initial).await?;

        // Echo all received messages
        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => {
                    if msg.body.is_empty() {
                        return Err(Error::Remote("got message with empty body".to_string()));
                    }
                    stream.msg_send(&msg).await?;
                }
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// Test infrastructure: creates connected client and server
async fn setup_e2e() -> (starpc::SrpcClient<SingleInMemoryOpener>, tokio::task::JoinHandle<()>) {
    let (opener, server_stream) = create_test_pair();

    // Set up the server
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoServer)).unwrap();
    let server = Server::with_arc(mux);

    // Spawn server handler
    let server_handle = tokio::spawn(async move {
        let _ = server.handle_stream(server_stream).await;
    });

    // Create client
    let client = starpc::SrpcClient::new(opener);

    (client, server_handle)
}

// ============================================================================
// Tests matching Go's server_test.go
// ============================================================================

#[tokio::test]
async fn test_e2e_unary() {
    let (client, server_handle) = setup_e2e().await;

    // Make unary call
    let request = EchoMsg {
        body: BODY_TXT.to_string(),
    };
    let response: EchoMsg = client
        .exec_call("echo.Echoer", "Echo", &request)
        .await
        .expect("exec_call failed");

    assert_eq!(response.body, BODY_TXT);

    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_server_stream() {
    let (client, server_handle) = setup_e2e().await;

    // Send request and open stream
    let request = EchoMsg {
        body: BODY_TXT.to_string(),
    };
    let data = request.encode_to_vec();
    let stream = client
        .new_stream("echo.Echoer", "EchoServerStream", Some(&data))
        .await
        .expect("new_stream failed");

    // Close send side
    stream.close_send().await.expect("close_send failed");

    // Expect to receive 5 messages
    let expected_rx = 5;
    let mut received = 0;

    loop {
        match stream.msg_recv::<EchoMsg>().await {
            Ok(msg) => {
                assert_eq!(msg.body, BODY_TXT);
                received += 1;
            }
            Err(Error::StreamClosed) => break,
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    assert_eq!(
        received, expected_rx,
        "expected {} messages, got {}",
        expected_rx, received
    );

    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_client_stream() {
    let (client, server_handle) = setup_e2e().await;

    // Open stream without initial message
    let stream = client
        .new_stream("echo.Echoer", "EchoClientStream", None)
        .await
        .expect("new_stream failed");

    // Send a message
    let request = EchoMsg {
        body: BODY_TXT.to_string(),
    };
    stream.msg_send(&request).await.expect("msg_send failed");

    // Close send side
    stream.close_send().await.expect("close_send failed");

    // Receive response
    let response: EchoMsg = stream.msg_recv().await.expect("msg_recv failed");
    assert_eq!(response.body, BODY_TXT);

    stream.close().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_bidi_stream() {
    let (client, server_handle) = setup_e2e().await;

    // Open bidirectional stream
    let stream = client
        .new_stream("echo.Echoer", "EchoBidiStream", None)
        .await
        .expect("new_stream failed");

    // Receive server's initial message
    let initial: EchoMsg = stream.msg_recv().await.expect("msg_recv failed");
    assert_eq!(initial.body, "hello from server");

    // Send a message from client
    let client_msg = EchoMsg {
        body: "hello from client".to_string(),
    };
    stream.msg_send(&client_msg).await.expect("msg_send failed");

    // Receive echoed message
    let echoed: EchoMsg = stream.msg_recv().await.expect("msg_recv failed");
    assert_eq!(echoed.body, "hello from client");

    // Close the stream
    stream.close().await.expect("close failed");
    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_multiple_bidi_messages() {
    let (client, server_handle) = setup_e2e().await;

    let stream = client
        .new_stream("echo.Echoer", "EchoBidiStream", None)
        .await
        .expect("new_stream failed");

    // Receive server's initial message
    let _: EchoMsg = stream.msg_recv().await.expect("initial recv failed");

    // Send and receive multiple messages
    for i in 0..10 {
        let msg = EchoMsg {
            body: format!("message {}", i),
        };
        stream.msg_send(&msg).await.expect("msg_send failed");

        let echoed: EchoMsg = stream.msg_recv().await.expect("msg_recv failed");
        assert_eq!(echoed.body, format!("message {}", i));
    }

    stream.close().await.expect("close failed");
    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_unary_empty_message() {
    let (client, server_handle) = setup_e2e().await;

    // Send empty message
    let request = EchoMsg {
        body: String::new(),
    };
    let response: EchoMsg = client
        .exec_call("echo.Echoer", "Echo", &request)
        .await
        .expect("exec_call failed");

    assert_eq!(response.body, "");

    server_handle.abort();
}

#[tokio::test]
async fn test_e2e_unimplemented_method() {
    let (client, server_handle) = setup_e2e().await;

    let request = EchoMsg {
        body: "test".to_string(),
    };
    let result: Result<EchoMsg> = client
        .exec_call("echo.Echoer", "NonExistentMethod", &request)
        .await;

    assert!(result.is_err());

    server_handle.abort();
}

#[tokio::test]
async fn test_codec_wire_format() {
    use starpc::codec::PacketCodec;
    use starpc::proto::{packet::Body, CallData, CallStart, Packet};
    use tokio_util::codec::{Decoder, Encoder};

    let mut codec = PacketCodec::new();
    let mut buf = bytes::BytesMut::new();

    // Test CallStart encoding
    let call_start = Packet {
        body: Some(Body::CallStart(CallStart {
            rpc_service: "test.Service".into(),
            rpc_method: "TestMethod".into(),
            data: vec![1, 2, 3, 4],
            data_is_zero: false,
        })),
    };

    codec
        .encode(call_start.clone(), &mut buf)
        .expect("encode failed");

    // Verify length prefix (little-endian u32)
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    assert_eq!(len, buf.len() - 4);

    // Decode and verify
    let decoded = codec
        .decode(&mut buf)
        .expect("decode failed")
        .expect("no packet");
    assert_eq!(decoded, call_start);

    // Test CallData encoding
    buf.clear();
    let call_data = Packet {
        body: Some(Body::CallData(CallData {
            data: vec![5, 6, 7, 8],
            data_is_zero: false,
            complete: true,
            error: String::new(),
        })),
    };

    codec
        .encode(call_data.clone(), &mut buf)
        .expect("encode failed");
    let decoded = codec
        .decode(&mut buf)
        .expect("decode failed")
        .expect("no packet");
    assert_eq!(decoded, call_data);

    // Test empty data with data_is_zero flag
    buf.clear();
    let empty_data = Packet {
        body: Some(Body::CallData(CallData {
            data: vec![],
            data_is_zero: true,
            complete: false,
            error: String::new(),
        })),
    };

    codec
        .encode(empty_data.clone(), &mut buf)
        .expect("encode failed");
    let decoded = codec
        .decode(&mut buf)
        .expect("decode failed")
        .expect("no packet");
    assert_eq!(decoded, empty_data);
}

#[tokio::test]
async fn test_packet_validation() {
    use starpc::packet::Validate;
    use starpc::proto::{packet::Body, CallData, CallStart, Packet};

    // Valid CallStart
    let valid_start = Packet {
        body: Some(Body::CallStart(CallStart {
            rpc_service: "svc".into(),
            rpc_method: "method".into(),
            data: vec![],
            data_is_zero: false,
        })),
    };
    assert!(valid_start.validate().is_ok());

    // Invalid CallStart - empty method
    let invalid_start = Packet {
        body: Some(Body::CallStart(CallStart {
            rpc_service: "svc".into(),
            rpc_method: String::new(),
            data: vec![],
            data_is_zero: false,
        })),
    };
    assert!(invalid_start.validate().is_err());

    // Valid CallData with data
    let valid_data = Packet {
        body: Some(Body::CallData(CallData {
            data: vec![1, 2, 3],
            data_is_zero: false,
            complete: false,
            error: String::new(),
        })),
    };
    assert!(valid_data.validate().is_ok());

    // Invalid CallData - empty everything
    let invalid_data = Packet {
        body: Some(Body::CallData(CallData {
            data: vec![],
            data_is_zero: false,
            complete: false,
            error: String::new(),
        })),
    };
    assert!(invalid_data.validate().is_err());

    // Empty packet
    let empty_packet = Packet { body: None };
    assert!(empty_packet.validate().is_err());
}

#[tokio::test]
async fn test_mux_registration_and_lookup() {
    let mux = Mux::new();

    // Register handler
    mux.register(Arc::new(EchoServer)).unwrap();

    // Check service exists
    assert!(mux.has_service("echo.Echoer"));
    assert!(!mux.has_service("nonexistent"));

    // Check methods exist
    assert!(mux.has_service_method("echo.Echoer", "Echo"));
    assert!(mux.has_service_method("echo.Echoer", "EchoServerStream"));
    assert!(!mux.has_service_method("echo.Echoer", "NonExistent"));

    // Empty strings should return false
    assert!(!mux.has_service(""));
    assert!(!mux.has_service_method("", "Echo"));
    assert!(!mux.has_service_method("echo.Echoer", ""));
}

#[tokio::test]
async fn test_error_types() {
    use starpc::error::codes;

    // Test error predicates
    assert!(Error::Aborted.is_abort());
    assert!(Error::Cancelled.is_abort());
    assert!(!Error::StreamClosed.is_abort());

    assert!(Error::StreamClosed.is_closed());
    assert!(Error::Cancelled.is_closed());

    assert!(Error::StreamIdle.is_timeout());

    assert!(Error::Unimplemented.is_unimplemented());

    // Test error codes
    assert_eq!(codes::ERR_RPC_ABORT, "ERR_RPC_ABORT");
    assert_eq!(codes::ERR_STREAM_IDLE, "ERR_STREAM_IDLE");
}
