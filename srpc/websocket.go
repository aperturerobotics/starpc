package srpc

import (
	"context"

	"github.com/coder/websocket"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-yamux/v4"
)

// NewWebSocketConn wraps a websocket into a MuxedConn.
// if yamuxConf is unset, uses the defaults.
func NewWebSocketConn(
	ctx context.Context,
	conn *websocket.Conn,
	isServer bool,
	yamuxConf *yamux.Config,
) (network.MuxedConn, error) {
	nc := websocket.NetConn(ctx, conn, websocket.MessageBinary)
	return NewMuxedConn(nc, !isServer, yamuxConf)
}
