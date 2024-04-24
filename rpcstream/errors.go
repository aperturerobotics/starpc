package rpcstream

import "errors"

var (
	// ErrNoServerForComponent is returned if the getter returns nil.
	ErrNoServerForComponent = errors.New("no server for that component")
	// ErrUnexpectedPacket is returned if the packet was unexpected.
	ErrUnexpectedPacket = errors.New("unexpected rpcstream packet")
)
