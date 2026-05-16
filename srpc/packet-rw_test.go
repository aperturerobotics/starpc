package srpc

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

type chunkedReadWriteCloser struct {
	bytes.Buffer
	maxWrite int
}

func (c *chunkedReadWriteCloser) Read([]byte) (int, error) {
	return 0, io.EOF
}

func (c *chunkedReadWriteCloser) Write(p []byte) (int, error) {
	if len(p) > c.maxWrite {
		p = p[:c.maxWrite]
	}
	return c.Buffer.Write(p)
}

func (c *chunkedReadWriteCloser) Close() error {
	return nil
}

func TestPacketReadWriterWritePacketHandlesShortWrites(t *testing.T) {
	pkt := NewCallDataPacket([]byte("packet payload"), false, true, nil)
	size := pkt.SizeVT()
	want := make([]byte, 4+size)
	binary.LittleEndian.PutUint32(want, uint32(size)) //nolint:gosec
	if _, err := pkt.MarshalToSizedBufferVT(want[4:]); err != nil {
		t.Fatal(err)
	}

	rwc := &chunkedReadWriteCloser{maxWrite: 3}
	if err := NewPacketReadWriter(rwc).WritePacket(pkt); err != nil {
		t.Fatal(err)
	}
	if got := rwc.Bytes(); !bytes.Equal(got, want) {
		t.Fatalf("written packet mismatch:\ngot  %x\nwant %x", got, want)
	}
}

func TestPacketUnmarshalCopiesByteFields(t *testing.T) {
	want := []byte("stable data")
	srcPkt := NewCallDataPacket(want, false, true, nil)
	data, err := srcPkt.MarshalVT()
	if err != nil {
		t.Fatal(err)
	}

	var pkt Packet
	if err := pkt.UnmarshalVT(data); err != nil {
		t.Fatal(err)
	}
	for i := range data {
		data[i] = 0xff
	}

	got := pkt.GetCallData().GetData()
	if !bytes.Equal(got, want) {
		t.Fatalf("unmarshal retained source bytes: got %q want %q", got, want)
	}
}
