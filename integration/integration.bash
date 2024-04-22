#!/bin/bash
set -eo pipefail

unset GOOS
unset GOARCH

echo "Compiling ts..."
../node_modules/.bin/esbuild integration.ts --bundle --sourcemap --platform=node --format=esm --outfile=integration.mjs

echo "Compiling go..."
go build -o integration -v ./

echo "Starting server..."
./integration &
PID=$!

function cleanup {
    kill -9 ${PID}
}
trap cleanup EXIT

sleep 1

pushd ../
echo "Starting client..."
node ./integration/integration.mjs
popd
