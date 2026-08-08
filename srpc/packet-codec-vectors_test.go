package srpc

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
)

type packetCodecVector struct {
	Name      string `json:"name"`
	PacketHex string `json:"packet_hex"`
	FrameHex  string `json:"frame_hex"`
}

func TestPacketCodecGoldenVectors(t *testing.T) {
	data, err := os.ReadFile("../testdata/packet-codec-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Cases []packetCodecVector `json:"cases"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	for _, tc := range document.Cases {
		if tc.PacketHex == "" || tc.FrameHex == "" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			packet := goldenPacket(t, tc.Name)
			packetData, err := packet.MarshalVT()
			if err != nil {
				t.Fatal(err)
			}
			if want := decodeHex(t, tc.PacketHex); !bytes.Equal(packetData, want) {
				t.Fatalf("packet = %x, want %x", packetData, want)
			}
			stream := &packetTestStream{}
			if err := NewPacketReadWriter(stream).WritePacket(packet); err != nil {
				t.Fatal(err)
			}
			if want := decodeHex(t, tc.FrameHex); !bytes.Equal(stream.writes, want) {
				t.Fatalf("frame = %x, want %x", stream.writes, want)
			}
		})
	}
}

func goldenPacket(t *testing.T, name string) *Packet {
	t.Helper()
	switch name {
	case "call_start_data":
		return NewCallStartPacket("svc", "method", []byte("abc"), false)
	case "call_start_absent_empty":
		return NewCallStartPacket("svc", "method", nil, false)
	case "call_start_present_empty":
		return NewCallStartPacket("svc", "method", nil, true)
	case "call_data_terminal":
		return NewCallDataPacket([]byte("out"), false, true, nil)
	case "call_data_error":
		return NewCallDataPacket(nil, false, false, errors.New("failed"))
	case "call_cancel":
		return NewCallCancelPacket()
	default:
		t.Fatalf("unknown golden packet %q", name)
		return nil
	}
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	data, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func framePacket(t *testing.T, packet *Packet) []byte {
	t.Helper()
	frame := make([]byte, 4+packet.SizeVT())
	binary.LittleEndian.PutUint32(frame, uint32(packet.SizeVT()))
	if _, err := packet.MarshalToSizedBufferVT(frame[4:]); err != nil {
		t.Fatal(err)
	}
	return frame
}

type packetTestStream struct {
	reads   bytes.Buffer
	writes  []byte
	maxRead int
}

func (s *packetTestStream) Read(data []byte) (int, error) {
	if s.maxRead > 0 && len(data) > s.maxRead {
		data = data[:s.maxRead]
	}
	return s.reads.Read(data)
}

func (s *packetTestStream) Write(data []byte) (int, error) {
	s.writes = append(s.writes, data...)
	return len(data), nil
}

func (s *packetTestStream) Close() error { return nil }

func TestPacketCodecReadFragmentsAndCoalesces(t *testing.T) {
	first := framePacket(t, NewCallCancelPacket())
	second := framePacket(t, NewCallDataPacket([]byte("x"), false, true, nil))
	input := append(first, second...)
	stream := &packetTestStream{reads: *bytes.NewBuffer(input)}
	decode := NewPacketDataHandler(func(*Packet) error { return nil })
	var count int
	err := NewPacketReadWriter(stream).ReadToHandler(func(data []byte) error {
		count++
		return decode(data)
	})
	if err != nil || count != 2 {
		t.Fatalf("ReadToHandler() = %v, packets=%d", err, count)
	}
}

func TestPacketCodecReadEveryFragmentBoundary(t *testing.T) {
	frame := framePacket(t, NewCallCancelPacket())
	decode := NewPacketDataHandler(func(*Packet) error { return nil })
	for size := 1; size <= len(frame); size++ {
		stream := &packetTestStream{reads: *bytes.NewBuffer(frame), maxRead: size}
		var count int
		err := NewPacketReadWriter(stream).ReadToHandler(func(data []byte) error {
			count++
			return decode(data)
		})
		if err != nil || count != 1 {
			t.Fatalf("chunk %d: err=%v count=%d", size, err, count)
		}
	}
}

func TestPacketCodecRejectsInvalidPrefixesAndMalformedPacket(t *testing.T) {
	for name, frame := range map[string][]byte{
		"zero":      {0, 0, 0, 0},
		"oversized": {0x81, 0x96, 0x98, 0x00},
	} {
		t.Run(name, func(t *testing.T) {
			stream := &packetTestStream{reads: *bytes.NewBuffer(frame)}
			if err := NewPacketReadWriter(stream).ReadToHandler(func([]byte) error { return nil }); err == nil {
				t.Fatal("accepted invalid prefix")
			}
		})
	}
	frame := []byte{3, 0, 0, 0, 0x0a, 0x01, 0xff}
	stream := &packetTestStream{reads: *bytes.NewBuffer(frame)}
	decode := NewPacketDataHandler(func(*Packet) error { return nil })
	if err := NewPacketReadWriter(stream).ReadToHandler(decode); err == nil {
		t.Fatal("accepted malformed protobuf")
	}
}

func TestPacketCodecCleanEOFReturnsNil(t *testing.T) {
	stream := &packetTestStream{reads: *bytes.NewBuffer(nil)}
	if err := NewPacketReadWriter(stream).ReadToHandler(func([]byte) error { return nil }); err != nil {
		t.Fatalf("clean EOF: %v", err)
	}
}

func TestPacketCodecTruncatedBodyAtEOF(t *testing.T) {
	frame := []byte{4, 0, 0, 0, 0x0a, 0x01}
	stream := &packetTestStream{reads: *bytes.NewBuffer(frame)}
	var count int
	err := NewPacketReadWriter(stream).ReadToHandler(func([]byte) error {
		count++
		return nil
	})
	if err != io.ErrUnexpectedEOF || count != 0 {
		t.Fatalf("err=%v count=%d", err, count)
	}
}

func TestPacketCodecWriteRejectsZeroPacket(t *testing.T) {
	if err := NewPacketReadWriter(&packetTestStream{}).WritePacket(&Packet{}); err == nil {
		t.Fatal("accepted zero-size packet")
	}
}
