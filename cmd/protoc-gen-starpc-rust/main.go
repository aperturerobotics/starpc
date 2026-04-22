// protoc-gen-starpc-rust generates Rust stubs for starpc services.
package main

import (
	"io"
	"os"

	"github.com/aperturerobotics/protobuf-go-lite/types/descriptorpb"
	pluginpb "github.com/aperturerobotics/protobuf-go-lite/types/pluginpb"
)

func main() {
	if err := run(); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

func run() error {
	// Read request from stdin.
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}

	var req pluginpb.CodeGeneratorRequest
	if err := req.UnmarshalVT(data); err != nil {
		return err
	}

	// Build file descriptor map.
	fileMap := make(map[string]*descriptorpb.FileDescriptorProto)
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
		generateFiles(resp, file, fileMap)
	}

	// Write response to stdout.
	out, err := resp.MarshalVT()
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(out)
	return err
}

func generateFiles(resp *pluginpb.CodeGeneratorResponse, file *descriptorpb.FileDescriptorProto, fileMap map[string]*descriptorpb.FileDescriptorProto) {
	g := &generator{file: file, fileMap: fileMap}

	// Determine output filename (strip .proto, add _srpc.pb.rs).
	name := file.GetName()
	if len(name) > 6 && name[len(name)-6:] == ".proto" {
		name = name[:len(name)-6]
	}

	// Generate Rust file.
	rsName := name + "_srpc.pb.rs"
	rsContent := g.generate()
	resp.File = append(resp.File, &pluginpb.CodeGeneratorResponse_File{
		Name:    &rsName,
		Content: &rsContent,
	})
}
