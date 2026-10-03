// protoc-gen-starpc-rust generates Rust stubs for starpc services.
package main

import (
	"io"
	"os"
	"strings"

	"github.com/aperturerobotics/protobuf-go-lite/types/descriptorpb"
	pluginpb "github.com/aperturerobotics/protobuf-go-lite/types/pluginpb"
)

// main reports a failed plugin request and exits without a partial response.
func main() {
	if err := run(); err != nil {
		// A failed diagnostic write cannot change the unsuccessful process outcome.
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

// run translates one protoc request into generated service files.
func run() error {
	// Read request from stdin.
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}

	// Decode the descriptor request before resolving imports.
	var req pluginpb.CodeGeneratorRequest
	if err := req.UnmarshalVT(data); err != nil {
		return err
	}

	// Name message types as the prost plugin does in the same request.
	opts, err := parseParams(req.GetParameter())
	if err != nil {
		return err
	}
	types, err := newTypeResolver(opts)
	if err != nil {
		return err
	}

	// Build file descriptor map.
	fileMap := make(map[string]*descriptorpb.FileDescriptorProto, len(req.ProtoFile))
	for _, f := range req.ProtoFile {
		fileMap[f.GetName()] = f
	}

	// Generate response.
	resp := &pluginpb.CodeGeneratorResponse{}
	supportedFeatures := uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL)
	resp.SupportedFeatures = &supportedFeatures

	// Process files to generate.
	for _, fileName := range req.FileToGenerate {
		file := fileMap[fileName]
		if file == nil || len(file.Service) == 0 {
			continue
		}
		generateFiles(resp, file, types)
	}

	// Write response to stdout.
	out, err := resp.MarshalVT()
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(out)
	return err
}

// generateFiles appends bindings for the services declared in one schema.
func generateFiles(resp *pluginpb.CodeGeneratorResponse, file *descriptorpb.FileDescriptorProto, types *typeResolver) {
	// Resolve the output name from the schema's import path.
	g := &generator{file: file, types: types}
	name := strings.TrimSuffix(file.GetName(), ".proto")

	// Generate Rust file.
	rsName := name + "_srpc.pb.rs"
	rsContent := g.generate()
	resp.File = append(resp.File, &pluginpb.CodeGeneratorResponse_File{
		Name:    &rsName,
		Content: &rsContent,
	})
}
