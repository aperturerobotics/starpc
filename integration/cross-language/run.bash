#!/bin/bash
# Cross-language integration tests for starpc.
# Runs all 12 server/client combinations across Go, TypeScript, Rust, and C++.
#
# Usage:
#   ./run.bash              # Run all pairs
#   ./run.bash go:ts        # Run go-server+ts-client and ts-server+go-client
#   ./run.bash go:ts go:rust # Run multiple pair filters
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Fixes errors with the generated esm using require()
ESM_BANNER='import{fileURLToPath}from"node:url";import{dirname}from"node:path";import{createRequire as topLevelCreateRequire}from"node:module";const require=topLevelCreateRequire(import.meta.url);const __filename=fileURLToPath(import.meta.url);const __dirname=dirname(__filename);'

FILTERS=("$@")

PASSED=0
FAILED=0
ERRORS=""

# should_run checks if a test name matches the active filters.
# Returns 0 (true) if the test should run, 1 (false) otherwise.
should_run() {
    local test_name="$1"
    if [ ${#FILTERS[@]} -eq 0 ]; then
        return 0
    fi
    for filter in "${FILTERS[@]}"; do
        local lang1="${filter%%:*}"
        local lang2="${filter##*:}"
        if [[ "$test_name" == *"${lang1}-"* && "$test_name" == *"${lang2}-"* ]]; then
            return 0
        fi
    done
    return 1
}

# Build all binaries.
echo "=== Building all integration binaries ==="

echo "Building Go server/client..."
go build -o "$SCRIPT_DIR/go-server/go-server" "$SCRIPT_DIR/go-server/"
go build -o "$SCRIPT_DIR/go-client/go-client" "$SCRIPT_DIR/go-client/"

echo "Building TypeScript server/client..."
"$REPO_DIR/node_modules/.bin/esbuild" "$SCRIPT_DIR/ts-server.ts" \
    --bundle --sourcemap --platform=node --format=esm \
    --banner:js="$ESM_BANNER" \
    --outfile="$SCRIPT_DIR/ts-server.mjs"
"$REPO_DIR/node_modules/.bin/esbuild" "$SCRIPT_DIR/ts-client.ts" \
    --bundle --sourcemap --platform=node --format=esm \
    --banner:js="$ESM_BANNER" \
    --outfile="$SCRIPT_DIR/ts-client.mjs"

echo "Building Rust server/client..."
cargo build --release --bin integration-server --bin integration-client 2>&1 | grep -v "^warning:" || true

echo "Building C++ server/client..."
mkdir -p "$REPO_DIR/build"
pushd "$REPO_DIR/build" > /dev/null
cmake "$REPO_DIR" -DCMAKE_BUILD_TYPE=Release > /dev/null 2>&1
cmake --build . --target cpp-integration-server cpp-integration-client --parallel > /dev/null 2>&1
popd > /dev/null

# Binary paths.
GO_SERVER="$SCRIPT_DIR/go-server/go-server"
GO_CLIENT="$SCRIPT_DIR/go-client/go-client"
TS_SERVER="$SCRIPT_DIR/ts-server.mjs"
TS_CLIENT="$SCRIPT_DIR/ts-client.mjs"
RUST_SERVER="$REPO_DIR/target/release/integration-server"
RUST_CLIENT="$REPO_DIR/target/release/integration-client"
CPP_SERVER="$REPO_DIR/build/cpp-integration-server"
CPP_CLIENT="$REPO_DIR/build/cpp-integration-client"

# Start a server and capture its address.
# Sets SERVER_PID and SERVER_ADDR.
start_server() {
    local addr_file
    addr_file=$(mktemp)
    "$@" > "$addr_file" 2>&1 &
    SERVER_PID=$!
    # Wait for LISTENING output (up to 3 seconds).
    local waited=0
    while [ $waited -lt 30 ]; do
        if grep -q 'LISTENING' "$addr_file" 2>/dev/null; then
            break
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    SERVER_ADDR=$(grep 'LISTENING' "$addr_file" 2>/dev/null | awk '{print $2}')
    rm -f "$addr_file"
    if [ -z "$SERVER_ADDR" ]; then
        echo "FAILED: server did not start"
        kill $SERVER_PID 2>/dev/null || true
        return 1
    fi
    return 0
}

stop_server() {
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
}

# run_pair <test_name> <server_args...> -- <client_args...>
# The client receives $SERVER_ADDR as its last argument.
run_pair() {
    local test_name="$1"
    shift

    if ! should_run "$test_name"; then
        return
    fi

    # Split args on "--".
    local srv_args=()
    local cli_args=()
    local in_client=false
    for arg in "$@"; do
        if [ "$arg" = "--" ]; then
            in_client=true
            continue
        fi
        if $in_client; then
            cli_args+=("$arg")
        else
            srv_args+=("$arg")
        fi
    done

    echo -n "  ${test_name}... "

    if ! start_server "${srv_args[@]}"; then
        echo "FAILED (server start)"
        FAILED=$((FAILED + 1))
        ERRORS="${ERRORS}\n  ${test_name} (server start failed)"
        return
    fi

    local client_out
    client_out=$(mktemp)
    if "${cli_args[@]}" "$SERVER_ADDR" > "$client_out" 2>&1; then
        echo "PASSED"
        PASSED=$((PASSED + 1))
    else
        echo "FAILED"
        FAILED=$((FAILED + 1))
        ERRORS="${ERRORS}\n  ${test_name}"
        echo "    client output:"
        sed 's/^/    /' "$client_out"
    fi
    rm -f "$client_out"

    stop_server
}

echo ""
echo "=== Running cross-language integration tests ==="
echo ""

# Go server combinations
run_pair "go-server + go-client"   "$GO_SERVER" -- "$GO_CLIENT"
run_pair "go-server + rust-client" "$GO_SERVER" -- "$RUST_CLIENT"
run_pair "go-server + ts-client"   "$GO_SERVER" -- node "$TS_CLIENT"
run_pair "go-server + cpp-client"  "$GO_SERVER" -- "$CPP_CLIENT"

# Rust server combinations
run_pair "rust-server + go-client"   "$RUST_SERVER" -- "$GO_CLIENT"
run_pair "rust-server + rust-client" "$RUST_SERVER" -- "$RUST_CLIENT"
run_pair "rust-server + ts-client"   "$RUST_SERVER" -- node "$TS_CLIENT"
run_pair "rust-server + cpp-client"  "$RUST_SERVER" -- "$CPP_CLIENT"

# TypeScript server combinations
run_pair "ts-server + go-client"   node "$TS_SERVER" -- "$GO_CLIENT"
run_pair "ts-server + rust-client" node "$TS_SERVER" -- "$RUST_CLIENT"
run_pair "ts-server + ts-client"   node "$TS_SERVER" -- node "$TS_CLIENT"
run_pair "ts-server + cpp-client"  node "$TS_SERVER" -- "$CPP_CLIENT"

# C++ server combinations
run_pair "cpp-server + go-client"   "$CPP_SERVER" -- "$GO_CLIENT"
run_pair "cpp-server + rust-client" "$CPP_SERVER" -- "$RUST_CLIENT"
run_pair "cpp-server + ts-client"   "$CPP_SERVER" -- node "$TS_CLIENT"
run_pair "cpp-server + cpp-client"  "$CPP_SERVER" -- "$CPP_CLIENT"

echo ""
echo "=== Results: ${PASSED} passed, ${FAILED} failed ==="
if [ $FAILED -gt 0 ]; then
    echo -e "Failed tests:${ERRORS}"
    exit 1
fi
