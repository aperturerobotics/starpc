package e2e_mock

import (
	context "context"

	srpc "github.com/aperturerobotics/starpc/srpc"
)

// MockServer implements the server for Mock.
type MockServer struct {
	// MockRequestCb is the callback to implement MockRequest.
	MockRequestCb func(ctx context.Context, msg *MockMsg) (*MockMsg, error)
}

// Register registers the Echo server with the Mux.
func (e *MockServer) Register(mux srpc.Mux) error {
	return SRPCRegisterMock(mux, e)
}

// MockRequest implements the mock request rpc.
func (e *MockServer) MockRequest(ctx context.Context, msg *MockMsg) (*MockMsg, error) {
	if e.MockRequestCb == nil {
		return nil, srpc.ErrUnimplemented
	}
	return e.MockRequestCb(ctx, msg)
}

// _ is a type assertion
var _ SRPCMockServer = ((*MockServer)(nil))
