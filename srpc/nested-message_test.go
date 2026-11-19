package srpc

import (
	"bytes"
	"context"
	"runtime"
	"testing"
)

// nestedTestPayload returns n bytes of a repeating pattern.
func nestedTestPayload(n int) []byte {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte(i%251 + 1)
	}
	return data
}

// discardReadWriteCloser accepts every write and reads nothing.
type discardReadWriteCloser struct{}

func (discardReadWriteCloser) Read([]byte) (int, error)    { return 0, context.Canceled }
func (discardReadWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (discardReadWriteCloser) Close() error                { return nil }

// TestNestedMessageMatchesGeneratedPacket checks that the nested call data
// packet has the bytes of the generated packet at every varint boundary.
func TestNestedMessageMatchesGeneratedPacket(t *testing.T) {
	for _, size := range []int{1, 2, 127, 128, 129, 16383, 16384, 16385, 70000} {
		payload := nestedTestPayload(size)

		// Marshal the generated packet around a copy of the payload.
		want, err := NewCallDataPacket(payload, false, false, nil).MarshalVT()
		if err != nil {
			t.Fatal(err)
		}

		// Marshal the nested packet around the payload itself.
		callData := NewNestedMessage(callDataDataField, NewRawMessage(payload, false))
		got, err := NewNestedMessage(packetCallDataField, callData).MarshalVT()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("size %d: nested packet differs from generated packet", size)
		}
	}
}

// TestWriteCallMessageFallsBackForPlainWriter checks that a writer that takes
// only decoded packets receives the same call data packet.
func TestWriteCallMessageFallsBackForPlainWriter(t *testing.T) {
	// Send one message through a writer that is not a PacketMessageWriter.
	writer := newPacketRecordingWriter()
	rpc := NewServerRPC(context.Background(), nil, writer)
	payload := nestedTestPayload(300)
	if err := NewMsgStream(context.Background(), rpc, nil).MsgSend(NewRawMessage(payload, false)); err != nil {
		t.Fatal(err)
	}

	// The packet carries the payload as call data.
	got := (<-writer.packets).GetCallData()
	if !bytes.Equal(got.GetData(), payload) || got.GetDataIsZero() {
		t.Fatalf("call data = %d bytes, zero=%v", len(got.GetData()), got.GetDataIsZero())
	}
}

// TestMsgSendEncodesOncePerFrame checks that MsgSend allocates one frame and
// no intermediate encoding of the message or its packet.
func TestMsgSendEncodesOncePerFrame(t *testing.T) {
	// Send through a packet read-writer, which encodes frames in place.
	ctx := context.Background()
	rpc := NewServerRPC(ctx, nil, NewPacketReadWriter(discardReadWriteCloser{}))
	strm := NewMsgStream(ctx, rpc, nil)
	msg := &CallData{Data: nestedTestPayload(256 * 1024)}

	// Measure the bytes allocated by repeated sends.
	const sends = 8
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for range sends {
		if err := strm.MsgSend(msg); err != nil {
			t.Fatal(err)
		}
	}
	runtime.ReadMemStats(&after)

	// A frame is the only buffer as large as the message; allow slack for headers.
	perSend := (after.TotalAlloc - before.TotalAlloc) / sends
	if limit := uint64(len(msg.Data)) * 3 / 2; perSend > limit {
		t.Fatalf("MsgSend allocated %d bytes per send, want at most %d", perSend, limit)
	}
}
