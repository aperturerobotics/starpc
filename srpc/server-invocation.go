package srpc

import "context"

// ServerInvocation exposes the terminal of a held unary server invocation.
type ServerInvocation interface {
	// WaitTerminal waits for a remote terminal or owner-context expiry. The
	// owner context must outlive the invocation context.
	WaitTerminal(ownerCtx context.Context) (TerminalKind, error)
	// Done returns the invocation context cancellation channel for diagnostics.
	Done() <-chan struct{}
}

type serverInvocationKey struct{}

func withServerInvocation(ctx context.Context, invocation ServerInvocation) context.Context {
	return context.WithValue(ctx, serverInvocationKey{}, invocation)
}

// GetServerInvocation returns the held unary invocation attached to a context.
func GetServerInvocation(ctx context.Context) (ServerInvocation, bool) {
	if ctx == nil {
		return nil, false
	}
	invocation, ok := ctx.Value(serverInvocationKey{}).(ServerInvocation)
	return invocation, ok
}

// WaitTerminal waits for and classifies the terminal of a held unary invocation.
func (r *ServerRPC) WaitTerminal(ownerCtx context.Context) (TerminalKind, error) {
	return r.commonRPC.WaitTerminal(ownerCtx)
}

// Done returns the invocation context cancellation channel for diagnostics.
func (r *ServerRPC) Done() <-chan struct{} {
	return r.ctx.Done()
}

// _ is a type assertion.
var _ ServerInvocation = (*ServerRPC)(nil)
