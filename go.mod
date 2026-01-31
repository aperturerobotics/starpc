module github.com/aperturerobotics/starpc

go 1.25

replace (
	// This fork uses go-protobuf-lite and adds post-quantum crypto support.
	github.com/libp2p/go-libp2p => github.com/aperturerobotics/go-libp2p v0.37.1-0.20241111002741-5cfbb50b74e0 // aperture

	// This fork uses go-protobuf-lite.
	github.com/libp2p/go-msgio => github.com/aperturerobotics/go-libp2p-msgio v0.0.0-20240511033615-1b69178aa5c8 // aperture
)

require (
	github.com/aperturerobotics/common v0.26.11 // latest
	github.com/aperturerobotics/protobuf-go-lite v0.12.0 // latest
	github.com/aperturerobotics/util v1.32.0 // latest
)

require (
	github.com/coder/websocket v1.8.14 // latest
	github.com/libp2p/go-libp2p v0.47.0 // latest
	github.com/libp2p/go-yamux/v4 v4.0.2 // latest
	github.com/pkg/errors v0.9.1 // latest
	github.com/sirupsen/logrus v1.9.4 // latest
	google.golang.org/protobuf v1.36.11 // latest
)

require (
	github.com/aperturerobotics/abseil-cpp v0.0.0-20260130220554-305ed0ea7006 // indirect
	github.com/aperturerobotics/cli v1.1.0 // indirect
	github.com/aperturerobotics/go-protoc-wasi v0.0.0-20260131050911-b5f94b044584 // indirect
	github.com/aperturerobotics/json-iterator-lite v1.0.1-0.20240713111131-be6bf89c3008 // indirect
	github.com/aperturerobotics/protobuf v0.0.0-20260131033322-bd4a2148b9c4 // indirect
)

require (
	github.com/ipfs/go-cid v0.4.1 // indirect
	github.com/klauspost/cpuid/v2 v2.2.8 // indirect
	github.com/libp2p/go-buffer-pool v0.1.0 // indirect
	github.com/minio/sha256-simd v1.0.1 // indirect
	github.com/mr-tron/base58 v1.2.0 // indirect
	github.com/multiformats/go-base32 v0.1.0 // indirect
	github.com/multiformats/go-base36 v0.2.0 // indirect
	github.com/multiformats/go-multiaddr v0.13.0 // indirect
	github.com/multiformats/go-multibase v0.2.0 // indirect
	github.com/multiformats/go-multihash v0.2.3 // indirect
	github.com/multiformats/go-multistream v0.5.0 // indirect
	github.com/multiformats/go-varint v0.0.7 // indirect
	github.com/spaolacci/murmur3 v1.1.0 // indirect
	github.com/tetratelabs/wazero v1.11.0 // indirect
	github.com/xrash/smetrics v0.0.0-20250705151800-55b8f293f342 // indirect
	golang.org/x/crypto v0.37.0 // indirect
	golang.org/x/exp v0.0.0-20250305212735-054e65f0b394 // indirect
	golang.org/x/mod v0.32.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
	lukechampine.com/blake3 v1.3.0 // indirect
)
