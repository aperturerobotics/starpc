package main

import (
	"strings"
	"testing"

	"github.com/aperturerobotics/protobuf-go-lite/types/descriptorpb"
)

// serviceFile declares one service, whose methods are given as name, input,
// output, client streaming, and server streaming, in package pkg.
func serviceFile(pkg, service string, methods ...*descriptorpb.MethodDescriptorProto) *descriptorpb.FileDescriptorProto {
	name := pkg + "/" + service + ".proto"
	return &descriptorpb.FileDescriptorProto{
		Name:    &name,
		Package: &pkg,
		Service: []*descriptorpb.ServiceDescriptorProto{{Name: &service, Method: methods}},
	}
}

// method builds a method descriptor.
func method(name, input, output string, clientStreaming, serverStreaming bool) *descriptorpb.MethodDescriptorProto {
	return &descriptorpb.MethodDescriptorProto{
		Name:            &name,
		InputType:       &input,
		OutputType:      &output,
		ClientStreaming: &clientStreaming,
		ServerStreaming: &serverStreaming,
	}
}

// TestGenerateResolvesMessageTypes checks that services name messages of other
// packages, nested messages, and extern types as the message files do.
func TestGenerateResolvesMessageTypes(t *testing.T) {
	g := &generator{
		file: serviceFile("fixture.api", "HTTPService",
			method("Unary", ".fixture.api.Request", ".fixture.shared.Reply", false, false),
			method("GetHTTPUrl", ".fixture.api.Outer.Inner", ".rpcstream.RpcStreamPacket", true, true),
			method("Type", ".google.protobuf.Empty", ".fixture.api.Request", false, true),
		),
		types: newTestResolver(t, "extern_path=.rpcstream=::starpc::rpcstream"),
	}
	out := g.generate()

	for _, want := range []string{
		"pub trait HttpServiceClient: Send + Sync {",
		"pub const HTTP_SERVICE_SERVICE_ID: &str = \"fixture.api.HTTPService\";",
		"async fn unary(&self, request: &Request) -> starpc::Result<super::shared::Reply>;",
		"pub trait HttpServiceGetHttpUrlStream: Send + Sync {",
		"async fn send(&self, msg: &outer::Inner) -> starpc::Result<()>;",
		"async fn recv(&self) -> starpc::Result<::starpc::rpcstream::RpcStreamPacket>;",
		"async fn get_http_url(&self) -> starpc::Result<Box<dyn HttpServiceGetHttpUrlStream>>;",
		"async fn r#type(&self, request: &()) -> starpc::Result<Box<dyn HttpServiceTypeStream>>;",
		"\"GetHTTPUrl\" =>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("generated output lacks %q", want)
		}
	}
}

// TestGenerateConstructorsUseFieldShorthand checks that constructors initialize
// a field that shares its parameter's name with the shorthand Clippy requires,
// and keep the retained-transport name of a service without methods.
func TestGenerateConstructorsUseFieldShorthand(t *testing.T) {
	// A service with methods stores its transport under the parameter name.
	withMethods := &generator{
		file:  serviceFile("fixture.api", "Echo", method("Say", ".fixture.api.Request", ".fixture.api.Request", false, false)),
		types: newTestResolver(t, ""),
	}
	out := withMethods.generate()
	for _, want := range []string{"Self { client }", "Self { server }"} {
		if !strings.Contains(out, want) {
			t.Errorf("generated output lacks %q", want)
		}
	}
	for _, redundant := range []string{"Self { client: client }", "Self { server: server }"} {
		if strings.Contains(out, redundant) {
			t.Errorf("generated output has redundant %q", redundant)
		}
	}

	// A service without methods stores it under an unused field name.
	empty := &generator{file: serviceFile("fixture.api", "Quiet"), types: newTestResolver(t, "")}
	out = empty.generate()
	for _, want := range []string{"Self { _client: client }", "Self { _server: server }"} {
		if !strings.Contains(out, want) {
			t.Errorf("generated output lacks %q", want)
		}
	}
}

// TestGenerateKeepsServiceFilesInOnePackageDistinct checks that the output of
// two service files that one Rust module includes declares no shared name.
func TestGenerateKeepsServiceFilesInOnePackageDistinct(t *testing.T) {
	// Render separate schemas that share a protobuf package and message type.
	types := newTestResolver(t, "")
	var outputs []string
	for _, service := range []string{"First", "Second"} {
		g := &generator{
			file:  serviceFile("fixture", service, method("Call", ".fixture.Msg", ".fixture.Msg", false, false)),
			types: types,
		}
		outputs = append(outputs, g.generate())
	}

	// The extension methods come in as an anonymous import, which cannot collide.
	for i, out := range outputs {
		if !strings.Contains(out, "use starpc::StreamExt as _;") {
			t.Errorf("output %d does not import the stream extension anonymously", i)
		}
		if strings.Contains(out, "use starpc::StreamExt;") {
			t.Errorf("output %d imports the stream extension by name", i)
		}
	}

	// Each item a service declares is named for the service.
	for _, shared := range []string{"pub trait FirstClient", "pub trait SecondClient", "FIRST_SERVICE_ID", "SECOND_SERVICE_ID"} {
		if !strings.Contains(outputs[0]+outputs[1], shared) {
			t.Errorf("outputs lack %q", shared)
		}
	}
	if strings.Contains(outputs[0], "Second") || strings.Contains(outputs[1], "First") {
		t.Error("a service file declares an item of the other service")
	}
}
