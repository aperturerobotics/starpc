package srpc

import (
	"context"

	"github.com/pkg/errors"
)

// Client implements a SRPC client which can initiate RPC streams.
type Client interface {
	// ExecCall executes a request/reply RPC with the remote.
	ExecCall(ctx context.Context, service, method string, in, out Message) error

	// NewStream starts a streaming RPC with the remote & returns the stream.
	// firstMsg is optional.
	NewStream(ctx context.Context, service, method string, firstMsg Message) (Stream, error)

	// NewRawStream opens a new raw stream with the remote.
	// Implements OpenStreamFunc.
	// msgHandler must not be called concurrently.
	NewRawStream(ctx context.Context, msgHandler PacketDataHandler, closeHandler CloseHandler) (Writer, error)
}

// OpenStreamFunc opens a stream with a remote.
// msgHandler must not be called concurrently.
type OpenStreamFunc = func(
	ctx context.Context,
	msgHandler PacketDataHandler,
	closeHandler CloseHandler,
) (Writer, error)

// client implements Client with a transport.
type client struct {
	// openStream opens a new stream.
	openStream OpenStreamFunc
}

// NewClient constructs a client with a OpenStreamFunc.
func NewClient(openStream OpenStreamFunc) Client {
	return &client{
		openStream: openStream,
	}
}

// ExecCall executes a request/reply RPC with the remote.
func (c *client) ExecCall(ctx context.Context, service, method string, in, out Message) error {
	firstMsg, err := in.MarshalVT()
	if err != nil {
		return err
	}

	clientRPC := NewClientRPC(ctx, service, method)
	defer clientRPC.Close()

	writer, err := c.openStream(ctx, clientRPC.HandlePacketData, clientRPC.HandleStreamClose)
	if err != nil {
		return err
	}
	if err := clientRPC.Start(writer, true, firstMsg); err != nil {
		return err
	}

	msg, err := clientRPC.ReadOne()
	if err != nil {
		// this includes any server returned error.
		return err
	}
	if err := out.UnmarshalVT(msg); err != nil {
		return errors.Wrap(ErrInvalidMessage, err.Error())
	}
	return nil
}

// NewStream starts a streaming RPC with the remote & returns the stream.
// firstMsg is optional.
func (c *client) NewStream(ctx context.Context, service, method string, firstMsg Message) (Stream, error) {
	var firstMsgData []byte
	if firstMsg != nil {
		var err error
		firstMsgData, err = firstMsg.MarshalVT()
		if err != nil {
			return nil, err
		}
	}

	clientRPC := NewClientRPC(ctx, service, method)
	writer, err := c.openStream(ctx, clientRPC.HandlePacketData, clientRPC.HandleStreamClose)
	if err != nil {
		return nil, err
	}
	if err := clientRPC.Start(writer, firstMsg != nil, firstMsgData); err != nil {
		return nil, err
	}

	return NewMsgStream(ctx, clientRPC, clientRPC.ctxCancel), nil
}

// NewRawStream opens a new raw stream with the remote.
// Implements OpenStreamFunc.
// msgHandler must not be called concurrently.
func (c *client) NewRawStream(
	ctx context.Context,
	msgHandler PacketDataHandler,
	closeHandler CloseHandler,
) (Writer, error) {
	return c.openStream(ctx, msgHandler, closeHandler)
}

// _ is a type assertion
var _ Client = ((*client)(nil))
