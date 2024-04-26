#!/bin/bash


protogen() {
    protoc \
        -I ./ \
        --plugin=../node_modules/.bin/protoc-gen-es-lite \
        --es-lite_out=./ \
        --es-lite_opt target=ts \
        --es-lite_opt ts_nocheck=false \
        --proto_path ./ \
        ./google/protobuf/*.proto
};

protogen
