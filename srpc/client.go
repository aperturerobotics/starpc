package srpc

import (
	"context"
	"io"

	"github.com/pkg/errors"
)

// Client implements a SRPC client which can initiate RPC streams.
type Client interface {
	// Invoke executes a unary RPC with the remote.
	Invoke(ctx context.Context, service, method string, in, out Message) error

	// NewStream starts a streaming RPC with the remote & returns the stream.
	// firstMsg is optional.
	NewStream(ctx context.Context, service, method string, firstMsg Message) (Stream, error)
}

// OpenStreamFunc opens a stream with a remote.
// msgHandler must not be called concurrently.
type OpenStreamFunc = func(ctx context.Context, msgHandler func(pkt *Packet) error) (Writer, error)

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

// Invoke executes a unary RPC with the remote.
func (c *client) Invoke(rctx context.Context, service, method string, in, out Message) error {
	ctx, ctxCancel := context.WithCancel(rctx)
	defer ctxCancel()

	firstMsg, err := in.MarshalVT()
	if err != nil {
		return err
	}
	clientRPC := NewClientRPC(ctx, service, method)
	writer, err := c.openStream(ctx, clientRPC.HandlePacket)
	if err != nil {
		return err
	}
	if err := clientRPC.Start(writer, firstMsg); err != nil {
		return err
	}
	msgs, err := clientRPC.ReadAll()
	if err != nil {
		// this includes any server returned error.
		return err
	}
	if len(msgs) == 0 {
		// no reply? return eof.
		return io.EOF
	}
	// parse first message to out
	if err := out.UnmarshalVT(msgs[0]); err != nil {
		return errors.Wrap(ErrInvalidMessage, err.Error())
	}
	// done
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
	writer, err := c.openStream(ctx, clientRPC.HandlePacket)
	if err != nil {
		return nil, err
	}
	if err := clientRPC.Start(writer, firstMsgData); err != nil {
		return nil, err
	}

	return NewRPCStream(ctx, clientRPC.writer, clientRPC.dataCh), nil
}

// _ is a type assertion
var _ Client = ((*client)(nil))
