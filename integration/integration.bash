#!/bin/bash
set -eo pipefail

unset GOOS
unset GOARCH

# Fixes errors with the generated esm using require()
# https://github.com/evanw/esbuild/issues/1944#issuecomment-1936954345
ESM_BANNER='import{fileURLToPath}from"node:url";import{dirname}from"node:path";import{createRequire as topLevelCreateRequire}from"node:module";const require=topLevelCreateRequire(import.meta.url);const __filename=fileURLToPath(import.meta.url);const __dirname=dirname(__filename);'
echo "Compiling ts..."
../node_modules/.bin/esbuild integration.ts \
                             --bundle \
                             --sourcemap \
                             --platform=node \
                             --format=esm \
                             --banner:js="$ESM_BANNER" \
                             --outfile=integration.mjs

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
