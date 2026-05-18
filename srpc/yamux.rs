//! Yamux transport adapters for starpc.

use async_trait::async_trait;
use futures::future::poll_fn;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};

use crate::client::{OpenStream, PacketReceiver};
use crate::error::{Error, Result};
use crate::invoker::Invoker;
use crate::rpc::PacketWriter;
use crate::server::Server;
use crate::transport::{create_packet_channel, DEFAULT_CHANNEL_BUFFER};

type OpenResult = std::result::Result<::yamux::Stream, ::yamux::ConnectionError>;
type OpenRequest = oneshot::Sender<OpenResult>;

/// YamuxStreamOpener opens Starpc packet streams over one yamux connection.
#[derive(Clone)]
pub struct YamuxStreamOpener {
    requests: mpsc::Sender<OpenRequest>,
}

impl YamuxStreamOpener {
    /// client creates a client-mode yamux opener over a Tokio transport.
    pub fn client<T>(transport: T) -> Self
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::client_with_config(transport, ::yamux::Config::default())
    }

    /// client_with_config creates a client-mode yamux opener with a custom config.
    pub fn client_with_config<T>(transport: T, config: ::yamux::Config) -> Self
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (requests, request_rx) = mpsc::channel(DEFAULT_CHANNEL_BUFFER);
        spawn_client_driver(transport.compat(), config, request_rx);
        Self { requests }
    }

    /// client_websocket creates a client-mode yamux opener over a WebSocket.
    #[cfg(feature = "websocket")]
    pub fn client_websocket<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::client(crate::websocket::websocket_byte_stream(socket))
    }

    /// client_websocket_with_config creates a client-mode yamux WebSocket opener with a custom config.
    #[cfg(feature = "websocket")]
    pub fn client_websocket_with_config<S>(
        socket: tokio_tungstenite::WebSocketStream<S>,
        config: ::yamux::Config,
    ) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::client_with_config(crate::websocket::websocket_byte_stream(socket), config)
    }
}

#[async_trait]
impl OpenStream for YamuxStreamOpener {
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
        let (tx, rx) = oneshot::channel();
        self.requests
            .send(tx)
            .await
            .map_err(|_| Error::StreamClosed)?;

        let stream = rx
            .await
            .map_err(|_| Error::StreamClosed)?
            .map_err(connection_error)?;
        let stream = stream.compat();
        let (read_half, write_half) = tokio::io::split(stream);
        Ok(create_packet_channel(read_half, write_half))
    }
}

/// handle_server_connection accepts yamux streams and serves each as Starpc.
pub async fn handle_server_connection<I, T>(
    server: &Server<I>,
    transport: T,
    config: ::yamux::Config,
) -> Result<()>
where
    I: Invoker + 'static,
    T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let mut connection =
        ::yamux::Connection::new(transport.compat(), config, ::yamux::Mode::Server);

    loop {
        match poll_fn(|cx| connection.poll_next_inbound(cx)).await {
            Some(Ok(stream)) => {
                let server = server.clone_for_spawn();
                tokio::spawn(async move {
                    if let Err(err) = server.handle_stream(stream.compat()).await {
                        server.report_error(err);
                    }
                });
            }
            Some(Err(err)) => return Err(connection_error(err)),
            None => return Ok(()),
        }
    }
}

enum DriverEvent {
    Opened(OpenRequest, OpenResult),
    Closed {
        pending: Option<OpenRequest>,
        err: Option<::yamux::ConnectionError>,
    },
}

fn spawn_client_driver<T>(
    transport: T,
    config: ::yamux::Config,
    mut requests: mpsc::Receiver<OpenRequest>,
) -> tokio::task::JoinHandle<()>
where
    T: futures::io::AsyncRead + futures::io::AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut connection = ::yamux::Connection::new(transport, config, ::yamux::Mode::Client);
        let mut pending = None;
        let mut requests_closed = false;

        loop {
            let event = poll_fn(|cx| {
                if pending.is_none() && !requests_closed {
                    match Pin::new(&mut requests).poll_recv(cx) {
                        std::task::Poll::Ready(Some(request)) => pending = Some(request),
                        std::task::Poll::Ready(None) => requests_closed = true,
                        std::task::Poll::Pending => {}
                    }
                }

                if let Some(request) = pending.take() {
                    match connection.poll_new_outbound(cx) {
                        std::task::Poll::Ready(result) => {
                            return std::task::Poll::Ready(DriverEvent::Opened(request, result));
                        }
                        std::task::Poll::Pending => pending = Some(request),
                    }
                }

                loop {
                    match connection.poll_next_inbound(cx) {
                        std::task::Poll::Ready(Some(Ok(_stream))) => continue,
                        std::task::Poll::Ready(Some(Err(err))) => {
                            return std::task::Poll::Ready(DriverEvent::Closed {
                                pending: pending.take(),
                                err: Some(err),
                            });
                        }
                        std::task::Poll::Ready(None) => {
                            return std::task::Poll::Ready(DriverEvent::Closed {
                                pending: pending.take(),
                                err: None,
                            });
                        }
                        std::task::Poll::Pending => return std::task::Poll::Pending,
                    }
                }
            })
            .await;

            match event {
                DriverEvent::Opened(request, result) => {
                    let _ = request.send(result);
                }
                DriverEvent::Closed { pending, err } => {
                    if let Some(request) = pending {
                        let _ = request.send(Err(err.unwrap_or(::yamux::ConnectionError::Closed)));
                    }
                    break;
                }
            }
        }
    })
}

fn connection_error(err: ::yamux::ConnectionError) -> Error {
    match err {
        ::yamux::ConnectionError::Io(err) => Error::Io(err),
        other => Error::Io(io::Error::new(io::ErrorKind::Other, other.to_string())),
    }
}
