package srpc

import (
	"context"
	"io"
	"net"

	"github.com/libp2p/go-libp2p/core/network"
	mplex "github.com/libp2p/go-libp2p/p2p/muxer/mplex"
	mp "github.com/libp2p/go-mplex"
)

// NewMuxedConn constructs a new MuxedConn from a net.Conn.
func NewMuxedConn(conn net.Conn, outbound bool) (network.MuxedConn, error) {
	m, err := mp.NewMultiplex(conn, outbound, nil)
	if err != nil {
		return nil, err
	}
	return mplex.NewMuxedConn(m), nil
}

// NewMuxedConnWithRwc builds a new MuxedConn with a io.ReadWriteCloser.
func NewMuxedConnWithRwc(ctx context.Context, rwc io.ReadWriteCloser, outbound bool) (network.MuxedConn, error) {
	return NewMuxedConn(NewRwcConn(ctx, rwc, nil, nil, 10), outbound)
}

// NewClientWithConn constructs the muxer and the client.
//
// uses libp2p mplex
func NewClientWithConn(conn net.Conn, outbound bool) (Client, error) {
	mconn, err := NewMuxedConn(conn, outbound)
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
		rw := NewPacketReadWriter(mstrm)
		go rw.ReadPump(msgHandler, closeHandler)
		return rw, nil
	}
}
