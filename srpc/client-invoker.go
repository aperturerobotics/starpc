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
// The remote's terminal result, including its error, is the result of the
// call. Returns false, nil if the client is nil.
func (c *ClientInvoker) InvokeMethod(serviceID, methodID string, strm Stream) (bool, error) {
	if c.client == nil {
		return false, nil
	}

	// Open a stream to the remote.
	remoteStrm, err := c.client.NewStream(strm.Context(), serviceID, methodID, nil)
	if err != nil {
		return true, err
	}
	defer remoteStrm.Close()

	// Forward the caller's messages until it half-closes or fails.
	go forwardRequests(strm, remoteStrm)

	// Forward the remote's messages; the server publishes the result to the
	// caller after this returns.
	return true, forwardMessages(remoteStrm, strm)
}

// forwardRequests copies the caller's messages to the remote, then
// half-closes the remote, or closes it when the caller fails.
func forwardRequests(caller, remote Stream) {
	if err := forwardMessages(caller, remote); err != nil {
		_ = remote.Close()
		return
	}
	_ = remote.CloseSend()
}

// forwardMessages copies messages from src to dst until src ends. It returns
// nil when src half-closes.
func forwardMessages(src, dst Stream) error {
	// Forward all messages including empty ones, which are valid empty protos.
	pkt := NewRawMessage(nil, true)
	for {
		if err := src.MsgRecv(pkt); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		err := dst.MsgSend(pkt)
		pkt.Clear()
		if err != nil {
			return err
		}
	}
}

// _ is a type assertion
var _ Invoker = (*ClientInvoker)(nil)
