//go:build deps_only
// +build deps_only

package tools

import (
	// _ imports the parent project.
	// this forces the versions in tools to be at least the versions in ..
	_ "github.com/aperturerobotics/starpc/srpc"

	// _ imports protowrap
	_ "github.com/aperturerobotics/goprotowrap/cmd/protowrap"
	// _ imports protoc-gen-go-lite
	_ "github.com/aperturerobotics/protobuf-go-lite/cmd/protoc-gen-go-lite"
	// _ imports golangci-lint
	_ "github.com/golangci/golangci-lint/cmd/golangci-lint"
	// _ imports golangci-lint commands
	_ "github.com/golangci/golangci-lint/pkg/commands"
	// _ imports go-mod-outdated
	_ "github.com/psampaz/go-mod-outdated"
	// _ imports protoc-gen-starpc
	_ "github.com/aperturerobotics/starpc/cmd/protoc-gen-go-starpc"
	// _ imports goimports
	_ "golang.org/x/tools/cmd/goimports"
	// _ imports gofumpt
	_ "mvdan.cc/gofumpt"

	// _ imports esbuild
	_ "github.com/evanw/esbuild/cmd/esbuild"
)
