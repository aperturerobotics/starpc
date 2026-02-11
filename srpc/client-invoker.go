package srpc

import (
	"io"
)

// ClientInvoker wraps a Client to implement the Invoker interface.
// It proxies incoming RPC calls to the remote via the client.
type ClientInvoker struct {
	// client is the client to proxy calls to
	client Client
}

// NewClientInvoker creates a new ClientInvoker.
func NewClientInvoker(client Client) *ClientInvoker {
	return &ClientInvoker{client: client}
}

// InvokeMethod invokes the method by proxying to the remote via the client.
// Returns false, nil if the client is nil.
func (c *ClientInvoker) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	if c.client == nil {
		return false, nil
	}

	ctx := strm.Context()

	// Open a stream to the remote
	remoteStrm, err := c.client.NewStream(ctx, serviceID, methodID, nil)
	if err != nil {
		return true, err
	}
	defer remoteStrm.Close()

	// Proxy data between the streams
	errCh := make(chan error, 2)
	go proxyStreamTo(strm, remoteStrm, errCh)
	go proxyStreamTo(remoteStrm, strm, errCh)

	// Wait for both directions to complete
	var outErr error
	for range 2 {
		if err := <-errCh; err != nil && outErr == nil && err != io.EOF {
			outErr = err
		}
	}
	return true, outErr
}

// proxyStreamTo copies messages from src to dst.
func proxyStreamTo(src, dst Stream, errCh chan error) {
	rerr := func() error {
		pkt := NewRawMessage(nil, true)
		for {
			err := src.MsgRecv(pkt)
			if err != nil {
				return err
			}
			// Forward all messages including empty ones (valid for empty proto messages)
			err = dst.MsgSend(pkt)
			pkt.Clear()
			if err != nil {
				return err
			}
		}
	}()

	if rerr != nil && rerr != io.EOF {
		if errCh != nil {
			errCh <- rerr
		}
		_ = dst.Close()
		return
	}

	rerr = dst.CloseSend()
	if errCh != nil {
		errCh <- rerr
	}
}

// _ is a type assertion
var _ Invoker = (*ClientInvoker)(nil)
