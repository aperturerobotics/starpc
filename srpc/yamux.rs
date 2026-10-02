//! Yamux transport adapters for starpc.

use async_trait::async_trait;
use futures::{future::poll_fn, stream::FuturesUnordered, StreamExt};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};

use crate::client::{OpenStream, PacketReceiver};
use crate::error::{Error, Result};
use crate::invoker::Invoker;
use crate::rpc::PacketWriter;
use crate::server::Server;
use crate::transport::{create_packet_channel, DEFAULT_CHANNEL_BUFFER};

type OpenResult = std::result::Result<::yamux::Stream, ::yamux::ConnectionError>;
type OpenRequest = oneshot::Sender<OpenResult>;

/// Opens StarPC packet streams over one owned yamux connection.
/// Clones share the connection. Dropping the last opener cancels its driver;
/// explicit close cancels and joins the driver before returning.
#[derive(Clone)]
pub struct YamuxStreamOpener {
    driver: Arc<ClientDriver>,
}

struct ClientDriver {
    requests: mpsc::Sender<OpenRequest>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for ClientDriver {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

impl YamuxStreamOpener {
    /// Creates a client-mode yamux opener over a Tokio transport.
    pub fn client<T>(transport: T) -> Self
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::client_with_config(transport, ::yamux::Config::default())
    }

    /// Creates a client-mode yamux opener with a custom configuration.
    pub fn client_with_config<T>(transport: T, config: ::yamux::Config) -> Self
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (requests, request_rx) = mpsc::channel(DEFAULT_CHANNEL_BUFFER);
        let task = spawn_client_driver(transport.compat(), config, request_rx);
        Self {
            driver: Arc::new(ClientDriver {
                requests,
                task: Mutex::new(Some(task)),
            }),
        }
    }

    /// Cancels the shared connection and joins its driver.
    /// Concurrent callers wait for the same completed teardown.
    pub async fn close(&self) {
        let mut task = self.driver.task.lock().await;
        if let Some(task) = task.as_mut() {
            task.abort();
            let _ = task.await;
        }
        task.take();
    }

    /// Creates a client-mode yamux opener over a WebSocket.
    #[cfg(feature = "websocket")]
    pub fn client_websocket<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::client(crate::websocket::websocket_byte_stream(socket))
    }

    /// Creates a client-mode yamux WebSocket opener with a custom configuration.
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
        self.driver
            .requests
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

/// Serves yamux substreams within this connection's owned lifetime.
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

    // Keep accepted calls within the connection's lifetime. Losing the connection
    // or dropping this future drops every call and its cancellation guard.
    let mut calls = FuturesUnordered::new();
    loop {
        tokio::select! {
            incoming = poll_fn(|cx| connection.poll_next_inbound(cx)) => {
                match incoming {
                    Some(Ok(stream)) => calls.push(server.handle_stream(stream.compat())),
                    Some(Err(err)) => return Err(connection_error(err)),
                    None => return Ok(()),
                }
            }
            Some(result) = calls.next(), if !calls.is_empty() => {
                if let Err(err) = result {
                    server.report_error(err);
                }
            }
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
) -> JoinHandle<()>
where
    T: futures::io::AsyncRead + futures::io::AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut connection = ::yamux::Connection::new(transport, config, ::yamux::Mode::Client);
        let mut pending = None;

        loop {
            let event = poll_fn(|cx| {
                if pending.is_none() {
                    match Pin::new(&mut requests).poll_recv(cx) {
                        std::task::Poll::Ready(Some(request)) => pending = Some(request),
                        std::task::Poll::Ready(None) => {
                            return std::task::Poll::Ready(DriverEvent::Closed {
                                pending: None,
                                err: None,
                            });
                        }
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
        other => Error::Io(io::Error::other(other.to_string())),
    }
}
