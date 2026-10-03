package main

import "testing"

// newTestResolver builds a resolver from a plugin parameter.
func newTestResolver(t *testing.T, parameter string) *typeResolver {
	// Build the resolver through the same parsing and validation as a plugin request.
	t.Helper()
	opts, err := parseParams(parameter)
	if err != nil {
		t.Fatal(err)
	}
	resolver, err := newTypeResolver(opts)
	if err != nil {
		t.Fatal(err)
	}
	return resolver
}

// TestResolveLocalTypes checks type paths relative to the module of a package.
func TestResolveLocalTypes(t *testing.T) {
	resolver := newTestResolver(t, "")
	tests := []struct {
		name, pkg, ident, want string
	}{
		{"same package", "echo", ".echo.EchoMsg", "EchoMsg"},
		{"no package", "", ".Msg", "Msg"},
		{"from no package", "", ".a.Msg", "a::Msg"},
		{"sibling package", "a.b", ".a.c.Msg", "super::c::Msg"},
		{"unrelated package", "x", ".y.z.Msg", "super::y::z::Msg"},
		{"nested message", "a", ".a.Outer.Inner", "outer::Inner"},
		{"acronym nested message", "a", ".a.HTTPServer.Inner", "http_server::Inner"},
		{"keyword package", "a", ".a.type.Msg", "r#type::Msg"},
		{"same keyword package", "a.type", ".a.type.Msg", "Msg"},
		{"upper case package", "x", ".Upper.case.Msg", "super::upper::case::Msg"},
		{"same upper case package", "Upper.case", ".Upper.case.Msg", "Msg"},
		{"well-known empty", "p", ".google.protobuf.Empty", "()"},
		{"well-known timestamp", "p", ".google.protobuf.Timestamp", "::prost_types::Timestamp"},
		{"well-known string value", "p", ".google.protobuf.StringValue", "::prost::alloc::string::String"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolver.resolve(tc.pkg, tc.ident); got != tc.want {
				t.Fatalf("resolve(%q, %q) = %q, want %q", tc.pkg, tc.ident, got, tc.want)
			}
		})
	}
}

// TestResolveExternPaths checks package prefix and exact message mappings.
func TestResolveExternPaths(t *testing.T) {
	// Combine exact, nested and package mappings in one resolver.
	resolver := newTestResolver(t, "extern_path=.rpcstream=::starpc::rpcstream,"+
		"extern_path=.shared.Thing=::shared_types::Thing,"+
		"extern_path=.a=::x,extern_path=.a.b=::y,extern_path=.c=crate::types")
	tests := []struct {
		name, ident, want string
	}{
		{"package prefix", ".rpcstream.RpcStreamPacket", "::starpc::rpcstream::RpcStreamPacket"},
		{"nested under a prefix", ".rpcstream.Outer.Inner", "::starpc::rpcstream::outer::Inner"},
		{"exact message", ".shared.Thing", "::shared_types::Thing"},
		{"message nested in an exact message", ".shared.Thing.Nested", "::shared_types::thing::Nested"},
		{"unmapped sibling of an exact message", ".shared.Other", "super::shared::Other"},
		{"longest prefix", ".a.b.C", "::y::C"},
		{"shorter prefix", ".a.D", "::x::D"},
		{"crate root", ".c.Msg", "crate::types::Msg"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolver.resolve("local", tc.ident); got != tc.want {
				t.Fatalf("resolve(%q) = %q, want %q", tc.ident, got, tc.want)
			}
		})
	}

	// Compiling the well-known types with the schemas removes their mappings.
	compiled := newTestResolver(t, "compile_well_known_types")
	if got, want := compiled.resolve("p", ".google.protobuf.Timestamp"), "super::google::protobuf::Timestamp"; got != want {
		t.Fatalf("resolve with compiled well-known types = %q, want %q", got, want)
	}
}

// TestParseParamsRejectsInvalidOptions checks the options the plugin refuses.
func TestParseParamsRejectsInvalidOptions(t *testing.T) {
	for _, parameter := range []string{
		"unknown_option",
		"extern_path=.a",
		"extern_path=a=::x",
		"extern_path=.a..b=::x",
		"extern_path=.a=::x,extern_path=.a=::y",
		"compile_well_known_types=maybe",
	} {
		opts, err := parseParams(parameter)
		if err == nil {
			_, err = newTypeResolver(opts)
		}
		if err == nil {
			t.Errorf("parameter %q was accepted", parameter)
		}
	}
}
