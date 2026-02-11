# Cross-Language Integration Testing Infrastructure

## Overview
Starpc includes a comprehensive cross-language integration testing framework that validates RPC protocol compatibility across Go, TypeScript, Rust, and C++. The framework tests 12 total cross-language combinations, with every server paired with every other language's client.

## Architecture

### Directory Structure
- `integration/cross-language/` - Main orchestration directory
- `integration/cross-language/run.bash` - Orchestration script that starts servers and runs clients
- `integration/cross-language/cpp-server.cpp` - C++ server implementation
- `integration/cross-language/cpp-client.cpp` - C++ client implementation
- `echo/integration_server.rs` - Rust server implementation
- `echo/integration_client.rs` - Rust client implementation
- `integration/cross-language/go-server.go` - Go server
- `integration/cross-language/go-client.go` - Go client
- `integration/cross-language/ts-server.ts` - TypeScript server (transpiled to ts-server.mjs)
- `integration/cross-language/ts-client.ts` - TypeScript client (transpiled to ts-client.mjs)

## Protocol Specification

### Transport Layer
- Raw TCP connections, one RPC per TCP connection
- 4-byte little-endian (LE) uint32 length prefix before each message
- Server startup behavior: All servers print "LISTENING 127.0.0.1:<port>" to stdout

### Server Binaries
- Go: `go-server`
- TypeScript: `ts-server.ts` → `ts-server.mjs` (via esbuild)
- Rust: `integration-server` (built from echo/Cargo.toml)
- C++: `cpp-server` (built from integration/cross-language/cpp-server.cpp)

### Client Binaries
- Go: `go-client`
- TypeScript: `ts-client.ts` → `ts-client.mjs` (via esbuild)
- Rust: `integration-client` (built from echo/Cargo.toml)
- C++: `cpp-client` (built from integration/cross-language/cpp-client.cpp)

## Test Patterns

The framework validates four core RPC patterns:
1. **Unary**: Single request-response
2. **ServerStream**: Server sends 5 messages in sequence
3. **ClientStream**: Client sends stream of messages
4. **BidiStream**: Bidirectional streaming; server sends "hello from server" as initial message

## Build Process

### Go
```bash
go build -o go-server ./integration/cross-language/go-server.go
go build -o go-client ./integration/cross-language/go-client.go
```

### TypeScript
- Built via esbuild to standalone .mjs files
- Executed with `node` or `bun`

### Rust
- Bins defined in `echo/Cargo.toml`
- Built with `cargo build --release`
- Binaries: `target/release/integration-server`, `target/release/integration-client`

### C++
- CMakeLists.txt targets: `cpp-integration-server`, `cpp-integration-client`
- Built via cmake

## Running Tests

### Manual Execution
```bash
cd integration/cross-language
bash run.bash
```

### npm/bun Script
```bash
bun run test:cross-language
```

### CI Integration
- Added to `.github/workflows/tests.yml`
- Runs as part of automated test suite

## Cross-Language Combinations Tested

All 12 combinations:
- Go server ↔ TS, Rust, C++ clients
- TS server ↔ Go, Rust, C++ clients
- Rust server ↔ Go, TS, C++ clients
- C++ server ↔ Go, TS, Rust clients

## Configuration References

### Cargo.toml Binaries (echo/)
- `integration-server`
- `integration-client`

### CMakeLists.txt Targets
- `cpp-integration-server`
- `cpp-integration-client`
