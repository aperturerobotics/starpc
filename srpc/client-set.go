package srpc

import (
	"context"
)

// ClientSet wraps a list of clients into one Client.
type ClientSet struct {
	clients []Client
}

// NewClientSet constructs a new client set.
func NewClientSet(clients []Client) *ClientSet {
	return &ClientSet{clients: clients}
}

// ExecCall executes a request/reply RPC with the remote.
func (c *ClientSet) ExecCall(
	ctx context.Context,
	service, method string,
	in, out Message,
) error {
	return c.execCall(ctx, func(client Client) error {
		return client.ExecCall(ctx, service, method, in, out)
	})
}

// NewStream starts a streaming RPC with the remote & returns the stream.
// firstMsg is optional.
func (c *ClientSet) NewStream(
	ctx context.Context,
	service, method string,
	firstMsg Message,
) (Stream, error) {
	var strm Stream
	err := c.execCall(ctx, func(client Client) error {
		var err error
		strm, err = client.NewStream(ctx, service, method, firstMsg)
		return err
	})
	return strm, err
}

// execCall executes the call conditionally retrying against subsequent client handles.
func (c *ClientSet) execCall(ctx context.Context, doCall func(client Client) error) error {
	var any bool
	for _, client := range c.clients {
		if client == nil {
			continue
		}
		err := doCall(client)
		any = true
		if err == nil {
			return nil
		}
		if err == context.Canceled {
			select {
			case <-ctx.Done():
				return context.Canceled
			default:
				continue
			}
		}
		if err.Error() == ErrUnimplemented.Error() {
			continue
		}
		return err
	}

	if !any {
		return ErrNoAvailableClients
	}

	return ErrUnimplemented
}

// _ is a type assertion
var _ Client = ((*ClientSet)(nil))
