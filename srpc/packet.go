// Package srpc implements Protobuf services over any transport that opens
// bidirectional packet streams: unary, server-streaming, client-streaming and
// bidirectional calls are all one stream each.
//
// A call is one stream of Packets. The client opens the stream with an
// OpenStreamFunc and sends CallStart, which names the service and method and may
// carry the first message; DataIsZero marks an empty message as present. Both
// sides then send CallData. Complete ends the sender's half of the call and the
// other half stays open, so a client can finish sending and still read the
// response. A non-empty Error or a nonzero ErrorCode fails the call and implies
// Complete; ErrorCode keeps a forwarded transport's reset or close before
// completion distinguishable from a handler's error. CallCancel cancels the
// call, and the server also sends it when its handler returns
// context.Canceled, so cancellation keeps its identity across the wire. Data
// after a side completed is ErrCompleted; a repeated completion is ignored.
//
// Over a byte stream, PacketReadWriter frames each Packet with a little-endian
// uint32 length prefix and refuses to write or read one larger than 10 MB. A
// muxed connection gives each call its own Yamux stream. A Server's Mux finds
// the Handler for the service ID and answers ErrUnimplemented for an unknown
// method.
//
// The Go, TypeScript, Rust, C++ and Python implementations share this wire
// format; integration/cross-language/run.bash runs 21 server and client pairs
// across them.
package srpc

import "github.com/pkg/errors"

// CloseHandler handles the stream closing with an optional error.
type CloseHandler = func(closeErr error)

// PacketHandler handles a packet.
//
// pkt is optional (can be nil)
// if closeErr is set, the stream is closed after pkt.
type PacketHandler = func(pkt *Packet) error

// PacketDataHandler handles a packet before it is parsed.
type PacketDataHandler = func(data []byte) error

// NewPacketDataHandler wraps a PacketHandler with a decoding step.
func NewPacketDataHandler(handler PacketHandler) PacketDataHandler {
	return func(data []byte) error {
		pkt := &Packet{}
		if err := pkt.UnmarshalVT(data); err != nil {
			return err
		}
		return handler(pkt)
	}
}

// Validate performs cursory validation of the packet.
func (p *Packet) Validate() error {
	switch b := p.GetBody().(type) {
	case *Packet_CallStart:
		return b.CallStart.Validate()
	case *Packet_CallData:
		return b.CallData.Validate()
	case *Packet_CallCancel:
		return nil
	default:
		return ErrUnrecognizedPacket
	}
}

// NewCallStartPacket constructs a new CallStart packet.
func NewCallStartPacket(service, method string, data []byte, dataIsZero bool) *Packet {
	return &Packet{Body: &Packet_CallStart{
		CallStart: &CallStart{
			RpcService: service,
			RpcMethod:  method,
			Data:       data,
			DataIsZero: dataIsZero,
		},
	}}
}

// Validate performs cursory validation of the packet.
func (p *CallStart) Validate() error {
	// Require both identifiers before a server dispatches the call.
	method := p.GetRpcMethod()
	if len(method) == 0 {
		return ErrEmptyMethodID
	}
	service := p.GetRpcService()
	if len(service) == 0 {
		return ErrEmptyServiceID
	}
	return nil
}

// NewCallDataPacket constructs a new CallData packet.
func NewCallDataPacket(data []byte, dataIsZero bool, complete bool, err error) *Packet {
	// Encode transport identity independently of its diagnostic text.
	var errStr string
	var code ErrorCode
	if err != nil {
		errStr = err.Error()
		switch {
		case errors.Is(err, ErrClosedBeforeCompletion):
			code = ErrorCode_ERROR_CODE_CLOSED_BEFORE_COMPLETION
		case errors.Is(err, ErrReset):
			code = ErrorCode_ERROR_CODE_RESET
		}
	}

	// Build the schema-defined terminal packet.
	return &Packet{Body: &Packet_CallData{
		CallData: &CallData{
			Data:       data,
			DataIsZero: dataIsZero,
			Complete:   err != nil || complete,
			Error:      errStr,
			ErrorCode:  code,
		},
	}}
}

// NewCallCancelPacket constructs a new CallCancel packet with cancel.
func NewCallCancelPacket() *Packet {
	return &Packet{Body: &Packet_CallCancel{CallCancel: true}}
}

// Validate performs cursory validation of the packet.
func (p *CallData) Validate() error {
	if len(p.GetData()) == 0 && !p.GetComplete() && len(p.GetError()) == 0 && !p.GetDataIsZero() && p.GetErrorCode() == ErrorCode_ERROR_CODE_UNKNOWN {
		return ErrEmptyPacket
	}
	return nil
}
