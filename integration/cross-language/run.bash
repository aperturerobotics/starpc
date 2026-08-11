#!/bin/bash
# Cross-language integration tests for starpc.
# Runs all 21 server/client combinations across Go, TypeScript, Rust, C++, and Python.
#
# Usage:
#   ./run.bash                         # Run all pairs
#   ./run.bash go:ts                   # Run go-server+ts-client and ts-server+go-client
#   ./run.bash python:go               # Run python-server+go-client and go-server+python-client
#   ./run.bash --nested ts:python      # Run nested TypeScript/Python pairs
#   ./run.bash --nested go:ts go:python ts:python # Run nested Go/TypeScript/Python pairs
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Fixes errors with the generated esm using require()
ESM_BANNER='import{fileURLToPath}from"node:url";import{dirname}from"node:path";import{createRequire as topLevelCreateRequire}from"node:module";const require=topLevelCreateRequire(import.meta.url);const __filename=fileURLToPath(import.meta.url);const __dirname=dirname(__filename);'

NESTED=false
FILTERS=()
for arg in "$@"; do
    if [ "$arg" = "--nested" ]; then
        NESTED=true
    else
        FILTERS+=("$arg")
    fi
done

needs_language() {
    local language="$1"
    if [ ${#FILTERS[@]} -eq 0 ]; then
        return 0
    fi
    for filter in "${FILTERS[@]}"; do
        if [[ ":${filter}:" == *":${language}:"* ]]; then
            return 0
        fi
    done
    return 1
}

PASSED=0
FAILED=0
ERRORS=""

SERVER_PID=""
SERVER_LOG=""
SERVER_EXIT_STATUS=0
CLIENT_PID=""
CLIENT_OUT=""

cleanup() {
    if [ -n "${CLIENT_PID:-}" ]; then
        kill "$CLIENT_PID" 2>/dev/null || true
        wait "$CLIENT_PID" 2>/dev/null || true
        CLIENT_PID=""
    fi
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
    fi
    if [ -n "${SERVER_LOG:-}" ]; then
        rm -f "$SERVER_LOG"
        SERVER_LOG=""
    fi
    if [ -n "${CLIENT_OUT:-}" ]; then
        rm -f "$CLIENT_OUT"
        CLIENT_OUT=""
    fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# should_run checks if a server/client pair matches the active filters.
# Returns 0 (true) if the test should run, 1 (false) otherwise.
should_run() {
    local test_name="$1"
    if [ ${#FILTERS[@]} -eq 0 ]; then
        return 0
    fi
    local server_language="${test_name%%-server*}"
    local client_language="${test_name#*+ }"
    client_language="${client_language%%-client*}"
    for filter in "${FILTERS[@]}"; do
        local lang1="${filter%%:*}"
        local lang2="${filter##*:}"
        if { [ "$server_language" = "$lang1" ] && [ "$client_language" = "$lang2" ]; } ||
            { [ "$server_language" = "$lang2" ] && [ "$client_language" = "$lang1" ]; }; then
            return 0
        fi
    done
    return 1
}

# Build all binaries.
echo "=== Building all integration binaries ==="

if needs_language go; then
    echo "Building Go server/client..."
    go build -o "$SCRIPT_DIR/go-server/go-server" "$SCRIPT_DIR/go-server/"
    go build -o "$SCRIPT_DIR/go-client/go-client" "$SCRIPT_DIR/go-client/"
fi

if needs_language ts; then
    echo "Building TypeScript server/client..."
    "$REPO_DIR/node_modules/.bin/esbuild" "$SCRIPT_DIR/ts-server.ts" \
        --bundle --sourcemap --platform=node --format=esm \
        --banner:js="$ESM_BANNER" \
        --outfile="$SCRIPT_DIR/ts-server.mjs"
    "$REPO_DIR/node_modules/.bin/esbuild" "$SCRIPT_DIR/ts-client.ts" \
        --bundle --sourcemap --platform=node --format=esm \
        --banner:js="$ESM_BANNER" \
        --outfile="$SCRIPT_DIR/ts-client.mjs"
fi

if needs_language rust; then
    echo "Building Rust server/client..."
    cargo build --release -p echo-example --bin integration-server --bin integration-client
fi

if needs_language cpp; then
    echo "Vendoring Go dependencies (needed for C++ build)..."
    go mod vendor
    echo "Building C++ server/client..."
    mkdir -p "$REPO_DIR/build"
    pushd "$REPO_DIR/build" > /dev/null
    cmake "$REPO_DIR" -DCMAKE_BUILD_TYPE=Release > /dev/null 2>&1
    cmake --build . --target cpp-integration-server cpp-integration-client --parallel > /dev/null 2>&1
    popd > /dev/null
fi

# Binary paths.
GO_SERVER="$SCRIPT_DIR/go-server/go-server"
GO_CLIENT="$SCRIPT_DIR/go-client/go-client"
TS_SERVER="$SCRIPT_DIR/ts-server.mjs"
TS_CLIENT="$SCRIPT_DIR/ts-client.mjs"
RUST_SERVER="$REPO_DIR/target/release/integration-server"
RUST_CLIENT="$REPO_DIR/target/release/integration-client"
CPP_SERVER="$REPO_DIR/build/cpp-integration-server"
CPP_CLIENT="$REPO_DIR/build/cpp-integration-client"
PYTHON=(uv run --project "$REPO_DIR" python)

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
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
        rm -f "$SERVER_LOG"
        SERVER_LOG=""
        return 1
    fi
    return 0
}

stop_server() {
    kill "$SERVER_PID" 2>/dev/null || true
    if wait "$SERVER_PID" 2>/dev/null; then
        SERVER_EXIT_STATUS=0
    else
        SERVER_EXIT_STATUS=$?
    fi
    SERVER_PID=""
}

python_server_passed() {
    local status="$1"
    local log="$2"
    [ "$status" -eq 0 ] && grep -qx "NESTED_CLEAN" "$log"
}

verify_python_server_guard() {
    local log
    log="$(mktemp)"
    printf '%s\n' "NESTED_CLEAN" >"$log"
    if python_server_passed 1 "$log"; then
        rm -f "$log"
        echo "runner guard accepted a nonzero Python server" >&2
        return 1
    fi
    if ! python_server_passed 0 "$log"; then
        rm -f "$log"
        echo "runner guard rejected a clean Python server" >&2
        return 1
    fi
    rm -f "$log"
}

# run_pair <test_name> <server_args...> -- <client_args...>
# The client receives $SERVER_ADDR as its last argument.
run_pair() {
    local test_name="$1"
    shift

    if ! should_run "$test_name"; then
        return
    fi

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

    CLIENT_OUT=$(mktemp)
    local client_ok=false
    timeout 60 "${cli_args[@]}" "$SERVER_ADDR" > "$CLIENT_OUT" 2>&1 &
    CLIENT_PID=$!
    if wait "$CLIENT_PID"; then
        client_ok=true
    fi
    CLIENT_PID=""
    stop_server
    if $NESTED && [[ "$test_name" == python-server* ]]; then
        if ! verify_python_server_guard; then
            client_ok=false
            echo "    Python server result guard regression failed"
        elif ! python_server_passed "$SERVER_EXIT_STATUS" "$SERVER_LOG"; then
            client_ok=false
            echo "    Python server failed nested shutdown (status $SERVER_EXIT_STATUS):"
            sed 's/^/    /' "$SERVER_LOG"
        fi
    fi

    if $client_ok; then
        echo "PASSED"
        PASSED=$((PASSED + 1))
    else
        echo "FAILED"
        FAILED=$((FAILED + 1))
        ERRORS="${ERRORS}\n  ${test_name}"
        echo "    client output:"
        sed 's/^/    /' "$CLIENT_OUT"
    fi
    rm -f "$CLIENT_OUT" "$SERVER_LOG"
    CLIENT_OUT=""
    SERVER_LOG=""
}

echo ""
echo "=== Running cross-language integration tests ==="
echo ""

if $NESTED; then
    # Nested streams have maintained Go, TypeScript, and Python endpoints.
    run_pair "go-server + ts-client" "$GO_SERVER" -- node "$TS_CLIENT" --nested
    run_pair "go-server + python-client" "$GO_SERVER" -- "${PYTHON[@]}" "$SCRIPT_DIR/python-client.py" --nested

    run_pair "ts-server + go-client" node "$TS_SERVER" -- "$GO_CLIENT" --nested
    run_pair "ts-server + python-client" node "$TS_SERVER" -- "${PYTHON[@]}" "$SCRIPT_DIR/python-client.py" --nested

    run_pair "python-server + go-client" "${PYTHON[@]}" "$SCRIPT_DIR/python-server.py" -- "$GO_CLIENT" --nested-release
    run_pair "python-server + ts-client" "${PYTHON[@]}" "$SCRIPT_DIR/python-server.py" -- node "$TS_CLIENT" --nested-release
else
    # Go server combinations
    run_pair "go-server + go-client"   "$GO_SERVER" -- "$GO_CLIENT"
    run_pair "go-server + rust-client" "$GO_SERVER" -- "$RUST_CLIENT"
    run_pair "go-server + ts-client"   "$GO_SERVER" -- node "$TS_CLIENT"
    run_pair "go-server + cpp-client"    "$GO_SERVER" -- "$CPP_CLIENT"
    run_pair "go-server + python-client" "$GO_SERVER" -- "${PYTHON[@]}" "$SCRIPT_DIR/python-client.py"

    # Rust server combinations
    run_pair "rust-server + go-client"   "$RUST_SERVER" -- "$GO_CLIENT"
    run_pair "rust-server + rust-client" "$RUST_SERVER" -- "$RUST_CLIENT"
    run_pair "rust-server + ts-client"   "$RUST_SERVER" -- node "$TS_CLIENT"
    run_pair "rust-server + cpp-client"  "$RUST_SERVER" -- "$CPP_CLIENT"

    # TypeScript server combinations
    run_pair "ts-server + go-client"   node "$TS_SERVER" -- "$GO_CLIENT"
    run_pair "ts-server + rust-client" node "$TS_SERVER" -- "$RUST_CLIENT"
    run_pair "ts-server + ts-client"   node "$TS_SERVER" -- node "$TS_CLIENT"
    run_pair "ts-server + cpp-client"    node "$TS_SERVER" -- "$CPP_CLIENT"
    run_pair "ts-server + python-client" node "$TS_SERVER" -- "${PYTHON[@]}" "$SCRIPT_DIR/python-client.py"

    # Python server combinations
    run_pair "python-server + go-client"     "${PYTHON[@]}" "$SCRIPT_DIR/python-server.py" -- "$GO_CLIENT"
    run_pair "python-server + ts-client"     "${PYTHON[@]}" "$SCRIPT_DIR/python-server.py" -- node "$TS_CLIENT" lifecycle
    run_pair "python-server + python-client" "${PYTHON[@]}" "$SCRIPT_DIR/python-server.py" -- "${PYTHON[@]}" "$SCRIPT_DIR/python-client.py"

    # C++ server combinations
    run_pair "cpp-server + go-client"   "$CPP_SERVER" -- "$GO_CLIENT"
    run_pair "cpp-server + rust-client" "$CPP_SERVER" -- "$RUST_CLIENT"
    run_pair "cpp-server + ts-client"   "$CPP_SERVER" -- node "$TS_CLIENT"
    run_pair "cpp-server + cpp-client"  "$CPP_SERVER" -- "$CPP_CLIENT"
fi

echo ""
echo "=== Results: ${PASSED} passed, ${FAILED} failed ==="
if [ $FAILED -gt 0 ]; then
    echo -e "Failed tests:${ERRORS}"
    exit 1
fi
