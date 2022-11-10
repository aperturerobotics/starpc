package srpc

import (
	"context"
	"io"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-yamux/v4"
	"nhooyr.io/websocket"
)

// WebSocketConn implements the p2p multiplexer over a WebSocket.
type WebSocketConn struct {
	// conn is the websocket conn
	conn *websocket.Conn
	// mconn is the muxed conn
	mconn network.MuxedConn
}

// NewWebSocketConn constructs a new WebSocket connection.
//
// if yamuxConf is unset, uses the defaults.
func NewWebSocketConn(ctx context.Context, conn *websocket.Conn, isServer bool, yamuxConf *yamux.Config) (*WebSocketConn, error) {
	nc := websocket.NetConn(ctx, conn, websocket.MessageBinary)
	muxedConn, err := NewMuxedConn(nc, !isServer, yamuxConf)
	if err != nil {
		return nil, err
	}
	return &WebSocketConn{conn: conn, mconn: muxedConn}, nil
}

// GetWebSocket returns the web socket conn.
func (w *WebSocketConn) GetWebSocket() *websocket.Conn {
	return w.conn
}

// GetOpenStreamFunc returns the OpenStream func.
func (w *WebSocketConn) GetOpenStreamFunc() OpenStreamFunc {
	return w.OpenStream
}

// AcceptStream accepts an incoming stream.
func (w *WebSocketConn) AcceptStream() (io.ReadWriteCloser, error) {
	strm, err := w.mconn.AcceptStream()
	if err != nil {
		return nil, err
	}
	return NewMuxedStreamRwc(strm), nil
}

// OpenStream tries to open a stream with the remote.
func (w *WebSocketConn) OpenStream(ctx context.Context, msgHandler PacketHandler, closeHandler CloseHandler) (Writer, error) {
	muxedStream, err := w.mconn.OpenStream(ctx)
	if err != nil {
		return nil, err
	}

	rw := NewPacketReadWriter(NewMuxedStreamRwc(muxedStream))
	go rw.ReadPump(msgHandler, closeHandler)
	return rw, nil
}

// Close closes the writer.
func (w *WebSocketConn) Close() error {
	return w.conn.Close(websocket.StatusGoingAway, "conn closed")
}
