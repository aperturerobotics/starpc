package srpc

import (
	"bytes"
	"testing"
)

// TestRawMessage tests the raw message container.
func TestRawMessage(t *testing.T) {
	pkt := NewCallStartPacket("test-service", "test-method", nil, false)
	data, err := pkt.MarshalVT()
	if err != nil {
		t.Fatal(err.Error())
	}

	rawMsg := &RawMessage{}
	if err := rawMsg.UnmarshalVT(data); err != nil {
		t.Fatal(err.Error())
	}

	outMsg, err := rawMsg.MarshalVT()
	if err != nil {
		t.Fatal(err.Error())
	}

	if !bytes.Equal(outMsg, data) {
		t.Fatal("not equal")
	}
}
