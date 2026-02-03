// protoc-gen-starpc-rust generates Rust stubs for starpc services.
package main

import (
	"io"
	"os"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
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
	if err := proto.Unmarshal(data, &req); err != nil {
		return err
	}

	// Build file descriptor map.
	fileMap := make(map[string]*descriptorpb.FileDescriptorProto)
	for _, f := range req.ProtoFile {
		fileMap[f.GetName()] = f
	}

	// Generate response.
	resp := &pluginpb.CodeGeneratorResponse{}
	resp.SupportedFeatures = proto.Uint64(uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL))

	// Process files to generate.
	for _, fileName := range req.FileToGenerate {
		file := fileMap[fileName]
		if file == nil || len(file.Service) == 0 {
			continue
		}
		generateFiles(resp, file, fileMap)
	}

	// Write response to stdout.
	out, err := proto.Marshal(resp)
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
