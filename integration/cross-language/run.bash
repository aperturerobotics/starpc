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

SERVER_LOG=""

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
cargo build --release -p echo-example --bin integration-server --bin integration-client

echo "Vendoring Go dependencies (needed for C++ build)..."
go mod vendor

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

start_server() {
    SERVER_LOG=$(mktemp)
    "$@" > "$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    # Wait for LISTENING output (up to 3 seconds).
    local waited=0
    while [ $waited -lt 30 ]; do
        if grep -q 'LISTENING' "$SERVER_LOG" 2>/dev/null; then
            break
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    SERVER_ADDR=$(grep 'LISTENING' "$SERVER_LOG" 2>/dev/null | awk '{print $2}')
    if [ -z "$SERVER_ADDR" ]; then
        echo "FAILED: server did not start"
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
        rm -f "$SERVER_LOG"
        SERVER_LOG=""
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
# check_receipt_events verifies terminal markers after the receipt server
# naturally completes, so receipt synchronization is event/process-backed.
check_receipt_events() {
    local expected="$1"
    local event_log="$2"
    awk -v expected="$expected" '
        $0 == "SERVER_RECEIPT_TERMINAL " expected { terminal = NR; next }
        $0 == "SERVER_RECEIPT_ACK_WRITE " expected { ack_write = NR; next }
        $0 == "CLIENT_RECEIPT_RESOLVED " expected { client = NR; next }
        END {
            if (!terminal || !client) {
                exit 1
            }
            if (expected == "committed" &&
                (!ack_write || terminal >= ack_write || ack_write >= client)) {
                exit 1
            }
        }
    ' "$event_log"
}

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

    local expected_terminal=""
    case "$test_name" in
        *"receipt commit") expected_terminal="committed" ;;
        *"receipt abort") expected_terminal="canceled" ;;
        *"receipt loss") expected_terminal="transportLost" ;;
        *"receipt bare-close") expected_terminal="closed" ;;
    esac

    echo -n "  ${test_name}... "

    local event_fifo=""
    local event_log=""
    local event_reader=""
    if [ -n "$expected_terminal" ]; then
        event_fifo=$(mktemp)
        rm -f "$event_fifo"
        mkfifo "$event_fifo"
        event_log=$(mktemp)
        exec 3<>"$event_fifo"
        (
            exec 3>&-
            cat "$event_fifo" > "$event_log"
        ) &
        event_reader=$!
        export RECEIPT_EVENT_FIFO="$event_fifo"
    else
        unset RECEIPT_EVENT_FIFO
    fi

    if ! start_server "${srv_args[@]}"; then
        echo "FAILED (server start)"
        FAILED=$((FAILED + 1))
        ERRORS="${ERRORS}\n  ${test_name} (server start failed)"
        if [ -n "$event_reader" ]; then
            exec 3>&-
            kill "$event_reader" 2>/dev/null || true
            wait "$event_reader" 2>/dev/null || true
            rm -f "$event_fifo" "$event_log"
        fi
        unset RECEIPT_EVENT_FIFO
        return
    fi

    local client_out
    client_out=$(mktemp)
    local client_ok=false
    local server_ok=true
    if "${cli_args[@]}" "$SERVER_ADDR" > "$client_out" 2>&1; then
        client_ok=true
    fi

    if [ -n "$event_reader" ]; then
        if $client_ok; then
            if ! wait "$SERVER_PID"; then
                server_ok=false
            fi
        else
            stop_server
            wait "$SERVER_PID" 2>/dev/null || true
            server_ok=false
        fi
        exec 3>&-
        wait "$event_reader" 2>/dev/null || true
    else
        stop_server
    fi
    unset RECEIPT_EVENT_FIFO

    local terminal_ok=true
    if [ -n "$expected_terminal" ] &&
        ! check_receipt_events "$expected_terminal" "$event_log"; then
        terminal_ok=false
    fi

    if $client_ok && $server_ok && $terminal_ok; then
        echo "PASSED"
        if [ -n "$expected_terminal" ]; then
            echo "    receipt events:"
            sed 's/^/      /' "$event_log"
        fi
        PASSED=$((PASSED + 1))
    else
        echo "FAILED"
        FAILED=$((FAILED + 1))
        ERRORS="${ERRORS}\n  ${test_name}"
        if ! $client_ok; then
            echo "    client output:"
            sed 's/^/    /' "$client_out"
        fi
        if ! $terminal_ok; then
            echo "    receipt events:"
            sed 's/^/    /' "$event_log"
            echo "    server output:"
            sed 's/^/    /' "$SERVER_LOG"
        fi
    fi
    rm -f "$client_out" "$SERVER_LOG" "$event_fifo" "$event_log"
    SERVER_LOG=""
}

echo ""
echo "=== Running cross-language integration tests ==="
echo ""

# Go server combinations
run_pair "go-server + go-client"   "$GO_SERVER" -- "$GO_CLIENT"
run_pair "go-server + rust-client" "$GO_SERVER" -- "$RUST_CLIENT"
run_pair "go-server + ts-client"   "$GO_SERVER" -- node "$TS_CLIENT"
run_pair "go-server + ts-client receipt commit" "$GO_SERVER" receipt commit -- node "$TS_CLIENT" receipt commit
run_pair "go-server + ts-client receipt abort" "$GO_SERVER" receipt abort -- node "$TS_CLIENT" receipt abort
run_pair "go-server + ts-client receipt loss" "$GO_SERVER" receipt loss -- node "$TS_CLIENT" receipt loss
run_pair "go-server + ts-client receipt bare-close" "$GO_SERVER" receipt bare-close -- node "$TS_CLIENT" receipt bare-close
run_pair "go-server + cpp-client"  "$GO_SERVER" -- "$CPP_CLIENT"

# Rust server combinations
run_pair "rust-server + go-client"   "$RUST_SERVER" -- "$GO_CLIENT"
run_pair "rust-server + rust-client" "$RUST_SERVER" -- "$RUST_CLIENT"
run_pair "rust-server + ts-client"   "$RUST_SERVER" -- node "$TS_CLIENT"
run_pair "rust-server + cpp-client"  "$RUST_SERVER" -- "$CPP_CLIENT"

# TypeScript server combinations
run_pair "ts-server + go-client"   node "$TS_SERVER" -- "$GO_CLIENT"
run_pair "ts-server + go-client receipt commit" node "$TS_SERVER" receipt commit -- "$GO_CLIENT" receipt commit
run_pair "ts-server + go-client receipt abort" node "$TS_SERVER" receipt abort -- "$GO_CLIENT" receipt abort
run_pair "ts-server + go-client receipt loss" node "$TS_SERVER" receipt loss -- "$GO_CLIENT" receipt loss
run_pair "ts-server + go-client receipt bare-close" node "$TS_SERVER" receipt bare-close -- "$GO_CLIENT" receipt bare-close
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
