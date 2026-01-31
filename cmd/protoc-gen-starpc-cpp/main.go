// protoc-gen-starpc-cpp generates C++ stubs for starpc services.
package main

import (
	"io"
	"os"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
)

func main() {
	// Read request from stdin
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}

	var req pluginpb.CodeGeneratorRequest
	if err := proto.Unmarshal(data, &req); err != nil {
		panic(err)
	}

	// Build file descriptor map
	fileMap := make(map[string]*descriptorpb.FileDescriptorProto)
	for _, f := range req.ProtoFile {
		fileMap[f.GetName()] = f
	}

	// Generate response
	resp := &pluginpb.CodeGeneratorResponse{}
	resp.SupportedFeatures = proto.Uint64(uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL))

	// Process files to generate
	for _, fileName := range req.FileToGenerate {
		file := fileMap[fileName]
		if file == nil || len(file.Service) == 0 {
			continue
		}
		generateFiles(resp, file, fileMap)
	}

	// Write response to stdout
	out, err := proto.Marshal(resp)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(out)
}

func generateFiles(resp *pluginpb.CodeGeneratorResponse, file *descriptorpb.FileDescriptorProto, fileMap map[string]*descriptorpb.FileDescriptorProto) {
	g := &generator{file: file, fileMap: fileMap}

	// Determine output filename prefix (strip .proto, add path)
	name := file.GetName()
	if len(name) > 6 && name[len(name)-6:] == ".proto" {
		name = name[:len(name)-6]
	}

	// Generate header file
	hppName := name + "_srpc.pb.hpp"
	hppContent := g.generateHeader()
	resp.File = append(resp.File, &pluginpb.CodeGeneratorResponse_File{
		Name:    &hppName,
		Content: &hppContent,
	})

	// Generate implementation file
	cppName := name + "_srpc.pb.cpp"
	cppContent := g.generateSource()
	resp.File = append(resp.File, &pluginpb.CodeGeneratorResponse_File{
		Name:    &cppName,
		Content: &cppContent,
	})
}
