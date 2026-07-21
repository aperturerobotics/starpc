package srpc

import (
	"context"
	"io"
	"sync/atomic"

	"github.com/pkg/errors"
)

// ExecCallReceipt executes a unary call over cc.NewStream, reads the single
// response into out, and returns a held receipt. The caller must dispose it
// with Commit, Abort, or Close.
func ExecCallReceipt(
	ctx context.Context,
	cc Client,
	service, method string,
	in, out Message,
) (*CallReceipt, error) {
	strm, err := cc.NewStream(ctx, service, method, in)
	if err != nil {
		return nil, err
	}
	if err := strm.MsgRecv(out); err != nil {
		_ = strm.Close()
		return nil, err
	}
	return &CallReceipt{strm: strm}, nil
}

// CallReceipt holds a unary call until the server finalizes it.
type CallReceipt struct {
	strm     Stream
	disposed atomic.Bool
}

// Context returns the context of the held call.
func (r *CallReceipt) Context() context.Context {
	return r.strm.Context()
}

// Commit sends request completion and waits for the server completion
// acknowledgment before releasing the stream.
func (r *CallReceipt) Commit() error {
	if r.disposed.Swap(true) {
		return nil
	}

	if r.strm.Context().Err() != nil {
		_ = r.strm.Close()
		return context.Canceled
	}
	if err := r.strm.CloseSend(); err != nil {
		_ = r.strm.Close()
		return err
	}

	var done receiptDone
	err := r.strm.MsgRecv(&done)
	_ = r.strm.Close()
	if err == io.EOF {
		receipt, ok := r.strm.(receiptTerminalStream)
		if ok {
			terminal, terminalOK := receipt.receiptTerminalKind()
			if terminalOK && terminal == TerminalCommitted {
				return nil
			}
		}
		return errors.New("missing trailing completion acknowledgment")
	}
	if err == nil {
		return errors.New("unexpected trailing response data")
	}
	return err
}

// Abort sends request cancellation and releases the stream.
func (r *CallReceipt) Abort() error {
	if r.disposed.Swap(true) {
		return nil
	}
	return r.strm.Close()
}

// Close aborts the held call unless it has already reached a terminal.
func (r *CallReceipt) Close() error {
	return r.Abort()
}

// receiptDone is a no-op message used to read the trailing completion packet.
type receiptDone struct{}

func (*receiptDone) SizeVT() int {
	return 0
}

func (*receiptDone) MarshalToSizedBufferVT([]byte) (int, error) {
	return 0, nil
}

func (*receiptDone) MarshalVT() ([]byte, error) {
	return nil, nil
}

func (*receiptDone) UnmarshalVT([]byte) error {
	return nil
}

func (*receiptDone) Reset() {}

// _ is a type assertion.
var _ Message = (*receiptDone)(nil)
