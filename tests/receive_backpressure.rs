//! Receive backpressure through the framed byte transport and shared RPC state.

use bytes::Bytes;
use futures::StreamExt;
use starpc::{packet, rpc::ClientRpc, transport, Context, Error, Stream};

/// A paused consumer stops packet processing before a later terminal verdict.
#[tokio::test]
async fn framed_transport_waits_for_receive_capacity() {
    // Fit three packets in the byte transport before starting the packet reader.
    let (client_io, peer_io) = tokio::io::duplex(4096);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (writer, mut incoming) = transport::create_packet_channel(client_read, client_write);
    let rpc = ClientRpc::new(Context::new(), "test".into(), "stream".into(), writer);
    let (peer_read, peer_write) = tokio::io::split(peer_io);
    let (peer, _incoming) = transport::create_packet_channel(peer_read, peer_write);
    for value in 1..=3 {
        peer.write_packet(packet::new_call_data_full(
            Some(Bytes::from(vec![value; 1024])),
            value == 3,
            None,
        ))
        .await
        .unwrap();
    }

    // Drive the production packet-reader path until the unread message blocks it.
    let read = async {
        while let Some(packet) = incoming.next().await {
            rpc.handle_packet(packet).await.unwrap();
        }
        rpc.handle_stream_close(None).await.unwrap();
    };
    tokio::pin!(read);
    assert!(futures::poll!(&mut read).is_pending());
    let completed = rpc.wait();
    tokio::pin!(completed);
    assert!(futures::poll!(&mut completed).is_pending());

    // Each receive lets the next packet advance, preserving all bytes and the final verdict.
    for value in 1..=3 {
        assert_eq!(
            rpc.recv_bytes().await.unwrap(),
            Bytes::from(vec![value; 1024])
        );
        assert!(futures::poll!(&mut read).is_pending());
    }
    completed.await.unwrap();
    assert!(matches!(rpc.recv_bytes().await, Err(Error::StreamClosed)));

    // Transport shutdown terminates the same packet reader after its final payload.
    peer.close().await.unwrap();
    read.await;
}
