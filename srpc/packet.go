package srpc

// PacketHandler handles a packet.
type PacketHandler = func(pkt *Packet) error

// Validate performs cursory validation of the packet.
func (p *Packet) Validate() error {
	switch b := p.GetBody().(type) {
	case *Packet_CallStart:
		return b.CallStart.Validate()
	case *Packet_CallData:
		return b.CallData.Validate()
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
	var errStr string
	if err != nil {
		errStr = err.Error()
	}
	return &Packet{Body: &Packet_CallData{
		CallData: &CallData{
			Data:       data,
			DataIsZero: dataIsZero,
			Complete:   err != nil || complete,
			Error:      errStr,
		},
	}}
}

// Validate performs cursory validation of the packet.
func (p *CallData) Validate() error {
	if len(p.GetData()) == 0 && !p.GetComplete() && len(p.GetError()) == 0 {
		return ErrEmptyPacket
	}
	return nil
}
