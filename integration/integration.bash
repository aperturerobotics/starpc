#!/bin/bash
set -eo pipefail

echo "Compiling ts..."
# ../node_modules/.bin/tsc --out integration.js --project tsconfig.json
../node_modules/.bin/esbuild integration.ts --bundle --platform=node --outfile=integration.js 

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
# node --loader ts-node/esm ./integration/integration.ts
# ./node_modules/.bin/ts-node --experimental-specifier-resolution=node --esm ./integration/integration.ts
echo "Starting client..."
node ./integration/integration.js
popd
