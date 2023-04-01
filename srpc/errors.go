package srpc

import "errors"

var (
	// ErrUnimplemented is returned if the RPC method was not implemented.
	ErrUnimplemented = errors.New("unimplemented")
	// ErrCompleted is returned if a message is received after the rpc was completed.
	ErrCompleted = errors.New("unexpected packet after rpc was completed")
	// ErrUnrecognizedPacket is returned if the packet type was not recognized.
	ErrUnrecognizedPacket = errors.New("unrecognized packet type")
	// ErrEmptyPacket is returned if nothing is specified in a packet.
	ErrEmptyPacket = errors.New("invalid empty packet")
	// ErrInvalidMessage indicates the message failed to parse.
	ErrInvalidMessage = errors.New("invalid message")
	// ErrEmptyMethodID is returned if the method id was empty.
	ErrEmptyMethodID = errors.New("method id empty")
	// ErrEmptyServiceID is returned if the service id was empty.
	ErrEmptyServiceID = errors.New("service id empty")
	// ErrNoAvailableClients is returned if no clients were available.
	ErrNoAvailableClients = errors.New("no available rpc clients")
)
