package main

import "testing"

// TestIdentifierRules checks the prost-build and heck conversions that decide
// every generated module, type, and method name.
func TestIdentifierRules(t *testing.T) {
	snake := map[string]string{
		"Upper":         "upper",
		"case":          "case",
		"GetHTTPUrl":    "get_http_url",
		"RPCStream":     "rpc_stream",
		"ServerStream":  "server_stream",
		"v2Api":         "v2_api",
		"already_snake": "already_snake",
		"type":          "r#type",
		"Type":          "r#type",
		"self":          "self_",
		"crate":         "crate_",
	}
	for name, want := range snake {
		if got := toSnake(name); got != want {
			t.Errorf("toSnake(%q) = %q, want %q", name, got, want)
		}
	}

	camel := map[string]string{
		"rpc_stream":  "RpcStream",
		"RPCStream":   "RpcStream",
		"EchoMsg":     "EchoMsg",
		"HTTPService": "HttpService",
		"Self":        "Self_",
	}
	for name, want := range camel {
		if got := toUpperCamel(name); got != want {
			t.Errorf("toUpperCamel(%q) = %q, want %q", name, got, want)
		}
	}
}
