module github.com/aperturerobotics/starpc

go 1.22

// Optional: this fork uses go-protobuf-lite.
replace github.com/libp2p/go-libp2p => github.com/aperturerobotics/go-libp2p v0.33.1-0.20240504075939-591fc65373be // aperture

// Optional: this fork avoids importing net/http on wasm.
replace nhooyr.io/websocket => github.com/paralin/nhooyr-websocket v1.8.12-0.20240504231911-2358de657064 // aperture-1

require (
	github.com/aperturerobotics/protobuf-go-lite v0.6.3 // latest
	github.com/aperturerobotics/util v1.23.1 // latest
)

require (
	github.com/libp2p/go-libp2p v0.33.2 // latest
	github.com/libp2p/go-yamux/v4 v4.0.2-0.20240322071716-53ef5820bd48 // master
	github.com/sirupsen/logrus v1.9.3 // latest
	google.golang.org/protobuf v1.34.1 // latest
	nhooyr.io/websocket v1.8.11 // latest
)

require github.com/pkg/errors v0.9.1

require (
	github.com/aperturerobotics/json-iterator-lite v1.0.0 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.2.0 // indirect
	github.com/ipfs/go-cid v0.4.1 // indirect
	github.com/klauspost/cpuid/v2 v2.2.7 // indirect
	github.com/libp2p/go-buffer-pool v0.1.0 // indirect
	github.com/minio/sha256-simd v1.0.1 // indirect
	github.com/mr-tron/base58 v1.2.0 // indirect
	github.com/multiformats/go-base32 v0.1.0 // indirect
	github.com/multiformats/go-base36 v0.2.0 // indirect
	github.com/multiformats/go-multiaddr v0.12.3 // indirect
	github.com/multiformats/go-multibase v0.2.0 // indirect
	github.com/multiformats/go-multicodec v0.9.0 // indirect
	github.com/multiformats/go-multihash v0.2.3 // indirect
	github.com/multiformats/go-multistream v0.5.0 // indirect
	github.com/multiformats/go-varint v0.0.7 // indirect
	github.com/spaolacci/murmur3 v1.1.0 // indirect
	golang.org/x/crypto v0.19.0 // indirect
	golang.org/x/exp v0.0.0-20240506185415-9bf2ced13842 // indirect
	golang.org/x/sys v0.18.0 // indirect
	lukechampine.com/blake3 v1.2.1 // indirect
)
