package rpcstream

import "github.com/pkg/errors"

var (
	// ErrNoServerForComponent is returned if the getter returns nil.
	ErrNoServerForComponent = errors.New("no server for that component")
	// ErrEmptyComponentID is returned if the component id was empty.
	ErrEmptyComponentID = errors.New("component id empty")
	// ErrUnexpectedPacket is returned if the packet was unexpected.
	ErrUnexpectedPacket = errors.New("unexpected rpcstream packet")
)
