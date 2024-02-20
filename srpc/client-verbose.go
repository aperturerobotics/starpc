package srpc

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/sirupsen/logrus"
)

// VClient implements a verbose SRPC client which can log RPC streams.
type VClient struct {
	le     *logrus.Entry
	client Client
	execID atomic.Int32
}

// NewVClient constructs a new verbose client wrapper.
func NewVClient(c Client, le *logrus.Entry) *VClient {
	return &VClient{le: le, client: c}
}

// ExecCall executes a request/reply RPC with the remote.
func (c *VClient) ExecCall(ctx context.Context, service, method string, in, out Message) (err error) {
	t1 := time.Now()
	id := c.execID.Add(1) - 1
	c.le.Debugf(
		"ExecCall(service(%s), method(%s)) => id(%d) started",
		service,
		method,
		id,
	)
	defer func() {
		c.le.Debugf(
			"ExecCall(service(%s), method(%s)) => id(%d) dur(%v) err(%v)",
			service,
			method,
			id,
			time.Since(t1).String(),
			err,
		)
	}()

	err = c.client.ExecCall(ctx, service, method, in, out)
	return err
}

// NewStream starts a streaming RPC with the remote & returns the stream.
// firstMsg is optional.
func (c *VClient) NewStream(ctx context.Context, service, method string, firstMsg Message) (stream Stream, err error) {
	t1 := time.Now()
	defer func() {
		c.le.Debugf(
			"NewStream(service(%s), method(%s)) => dur(%v) err(%v)",
			service,
			method,
			time.Since(t1).String(),
			err,
		)
	}()
	stream, err = c.client.NewStream(ctx, service, method, firstMsg)
	return stream, err
}

// NewRawStream opens a new raw stream with the remote.
// Implements OpenStreamFunc.
// msgHandler must not be called concurrently.
func (c *VClient) NewRawStream(ctx context.Context, msgHandler PacketDataHandler, closeHandler CloseHandler) (writer PacketWriter, err error) {
	t1 := time.Now()

	defer func() {
		c.le.Debugf(
			"NewRawStream() => dur(%v) writer(%v) err(%v)",
			time.Since(t1).String(),
			writer,
			err,
		)
	}()
	writer, err = c.client.NewRawStream(ctx, msgHandler, closeHandler)
	return writer, err
}
