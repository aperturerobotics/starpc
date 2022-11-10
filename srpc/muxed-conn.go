package srpc

import (
	"context"
	"io"
	"net"

	"github.com/libp2p/go-libp2p/core/network"
	ymuxer "github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	yamux "github.com/libp2p/go-yamux/v4"
)

// NewYamuxConfig builds the default yamux configuration.
func NewYamuxConfig() *yamux.Config {
	// Configuration options from go-libp2p-yamux:
	config := *ymuxer.DefaultTransport.Config()
	config.AcceptBacklog = 512
	return &config
}

// NewMuxedConn constructs a new MuxedConn from a net.Conn.
//
// If yamuxConf is nil, uses defaults.
func NewMuxedConn(conn net.Conn, outbound bool, yamuxConf *yamux.Config) (network.MuxedConn, error) {
	if yamuxConf == nil {
		yamuxConf = NewYamuxConfig()
	}

	var sess *yamux.Session
	var err error
	if outbound {
		sess, err = yamux.Client(conn, yamuxConf, nil)
	} else {
		sess, err = yamux.Server(conn, yamuxConf, nil)
	}
	if err != nil {
		return nil, err
	}

	return ymuxer.NewMuxedConn(sess), nil
}

// NewMuxedConnWithRwc builds a new MuxedConn with a io.ReadWriteCloser.
//
// If yamuxConf is nil, uses defaults.
func NewMuxedConnWithRwc(
	ctx context.Context,
	rwc io.ReadWriteCloser,
	outbound bool,
	yamuxConf *yamux.Config,
) (network.MuxedConn, error) {
	return NewMuxedConn(NewRwcConn(ctx, rwc, nil, nil, 10), outbound, yamuxConf)
}

// NewClientWithConn constructs the muxer and the client.
//
// if yamuxConf is nil, uses defaults.
func NewClientWithConn(conn net.Conn, outbound bool, yamuxConf *yamux.Config) (Client, error) {
	mconn, err := NewMuxedConn(conn, outbound, yamuxConf)
	if err != nil {
		return nil, err
	}
	return NewClientWithMuxedConn(mconn), nil
}

// NewClientWithMuxedConn constructs a new client with a MuxedConn.
func NewClientWithMuxedConn(conn network.MuxedConn) Client {
	openStreamFn := NewOpenStreamWithMuxedConn(conn)
	return NewClient(openStreamFn)
}

// NewOpenStreamWithMuxedConn constructs a OpenStream func with a MuxedConn.
func NewOpenStreamWithMuxedConn(conn network.MuxedConn) OpenStreamFunc {
	return func(ctx context.Context, msgHandler PacketHandler, closeHandler CloseHandler) (Writer, error) {
		mstrm, err := conn.OpenStream(ctx)
		if err != nil {
			return nil, err
		}
		rw := NewPacketReadWriter(NewMuxedStreamRwc(mstrm))
		go rw.ReadPump(msgHandler, closeHandler)
		return rw, nil
	}
}
