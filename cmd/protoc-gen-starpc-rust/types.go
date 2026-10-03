package main

import (
	"strings"

	"github.com/pkg/errors"
)

// This file ports the extern path rules of prost-build 0.14 (extern_paths.rs).
// The port is licensed as LICENSE.prost-build (Apache-2.0).

// prostPath and prostTypesPath are the crate paths prost-build uses for its
// runtime and its well-known types when no other path is configured.
const (
	// prostPath names the message runtime used by generated field types.
	prostPath = "::prost"
	// prostTypesPath names the default well-known message crate.
	prostTypesPath = "::prost_types"
)

// params are the generator options. They are the subset of the protoc-gen-prost
// options that decide how a message type is named, so that service bindings
// and message files agree on every type path.
type params struct {
	// externPaths maps a fully qualified protobuf path to a Rust path, in the
	// order given.
	externPaths [][2]string
	// compileWellKnownTypes disables the default mapping of the google.protobuf
	// types to prost-types.
	compileWellKnownTypes bool
}

// parseParams parses the comma-separated plugin parameter of a protoc request.
// It accepts extern_path=<proto path>=<rust path> and compile_well_known_types
// and rejects every other option.
func parseParams(s string) (*params, error) {
	p := &params{}
	for _, option := range splitParams(s) {
		name, rest, _ := strings.Cut(option, "=")
		switch name {
		case "extern_path":
			protoPath, rustPath, ok := strings.Cut(rest, "=")
			if !ok {
				return nil, errors.Errorf("invalid parameter: %s", option)
			}
			p.externPaths = append(p.externPaths, [2]string{protoPath, rustPath})
		case "compile_well_known_types":
			if rest != "" && rest != "true" && rest != "false" {
				return nil, errors.Errorf("invalid parameter: %s", option)
			}
			p.compileWellKnownTypes = rest != "false"
		default:
			return nil, errors.Errorf("invalid parameter: %s", option)
		}
	}
	return p, nil
}

// splitParams splits a parameter on commas that are not escaped with a
// backslash and drops empty options.
func splitParams(s string) []string {
	// Preserve escaped delimiters while separating plugin options.
	var options []string
	var current strings.Builder
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '\\' && i+1 < len(s) && (s[i+1] == ',' || s[i+1] == '\\'):
			i++
			current.WriteByte(s[i])
		case s[i] == ',':
			options = append(options, current.String())
			current.Reset()
		default:
			current.WriteByte(s[i])
		}
	}
	options = append(options, current.String())

	// Empty separators carry no option, including a trailing comma.
	nonEmpty := make([]string, 0, len(options))
	for _, option := range options {
		if option = strings.TrimSpace(option); option != "" {
			nonEmpty = append(nonEmpty, option)
		}
	}
	return nonEmpty
}

// typeResolver names the Rust type of a protobuf message as prost-build does.
type typeResolver struct {
	// externs maps a fully qualified protobuf path to the Rust path that
	// replaces it.
	externs map[string]string
}

// newTypeResolver builds the extern path table: the configured paths, then the
// well-known types unless they are compiled with the schemas. A path given
// twice is an error, as in prost-build.
func newTypeResolver(p *params) (*typeResolver, error) {
	// Each fully qualified mapping has one destination, matching Prost's validation.
	r := &typeResolver{externs: make(map[string]string)}
	add := func(protoPath, rustPath string) error {
		if !strings.HasPrefix(protoPath, ".") || strings.Contains(protoPath[1:], "..") || strings.HasSuffix(protoPath, ".") {
			return errors.Errorf("invalid extern protobuf path %q: it must be fully qualified", protoPath)
		}
		if _, ok := r.externs[protoPath]; ok {
			return errors.Errorf("duplicate extern protobuf path: %s", protoPath)
		}
		r.externs[protoPath] = rustPath
		return nil
	}

	// Register explicit mappings before selecting the well-known defaults.
	for _, extern := range p.externPaths {
		if err := add(extern[0], extern[1]); err != nil {
			return nil, err
		}
	}
	if p.compileWellKnownTypes {
		return r, nil
	}

	// Wrapper messages map to primitives; other well-known messages use prost-types.
	wellKnown := [][2]string{
		{".google.protobuf", prostTypesPath},
		{".google.protobuf.BoolValue", "bool"},
		{".google.protobuf.BytesValue", prostPath + "::alloc::vec::Vec<u8>"},
		{".google.protobuf.DoubleValue", "f64"},
		{".google.protobuf.Empty", "()"},
		{".google.protobuf.FloatValue", "f32"},
		{".google.protobuf.Int32Value", "i32"},
		{".google.protobuf.Int64Value", "i64"},
		{".google.protobuf.StringValue", prostPath + "::alloc::string::String"},
		{".google.protobuf.UInt32Value", "u32"},
		{".google.protobuf.UInt64Value", "u64"},
	}
	for _, extern := range wellKnown {
		if err := add(extern[0], extern[1]); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// resolve returns the Rust path of the fully qualified protobuf type name
// pbIdent, as written in a module whose protobuf package is pkg.
//
// An exact extern path wins, then the longest extern path that is a prefix of
// the name. Any other type is addressed relative to the module of pkg: one
// super for each package segment that the type's path does not share, then the
// snake-cased remaining package and enclosing message segments, then the type.
func (r *typeResolver) resolve(pkg, pbIdent string) string {
	// An extern mapping replaces both the package path and message name.
	if rustPath, ok := r.resolveExtern(pbIdent); ok {
		return rustPath
	}

	// Skip the leading segments the module and the type have in common.
	var local []string
	if pkg != "" {
		local = strings.Split(pkg, ".")
	}
	identPath := strings.Split(strings.TrimPrefix(pbIdent, "."), ".")
	identType := identPath[len(identPath)-1]
	identPath = identPath[:len(identPath)-1]
	for len(local) != 0 && len(identPath) != 0 && local[0] == identPath[0] {
		local = local[1:]
		identPath = identPath[1:]
	}

	// Climb out of the remaining module levels and descend to the type.
	segments := make([]string, 0, len(local)+len(identPath)+1)
	for range local {
		segments = append(segments, "super")
	}
	for _, segment := range identPath {
		segments = append(segments, toSnake(segment))
	}
	segments = append(segments, toUpperCamel(identType))
	return strings.Join(segments, "::")
}

// resolveExtern applies the extern path table to pbIdent. A mapping for the
// exact name is used as given. A mapping for an enclosing path is extended with
// the snake-cased segments below it and the type name, and each of its own
// segments is renamed like any module, except a leading crate.
func (r *typeResolver) resolveExtern(pbIdent string) (string, bool) {
	if rustPath, ok := r.externs[pbIdent]; ok {
		return rustPath, true
	}

	// Try each enclosing path from the longest to the shortest.
	for i := strings.LastIndex(pbIdent, "."); i > 0; i = strings.LastIndex(pbIdent[:i], ".") {
		rustPath, ok := r.externs[pbIdent[:i]]
		if !ok {
			continue
		}

		below := strings.Split(pbIdent[i+1:], ".")
		identType := toUpperCamel(below[len(below)-1])
		segments := append(strings.Split(rustPath, "::"), below[:len(below)-1]...)
		for j, segment := range segments {
			if j == 0 && segment == "crate" {
				continue
			}
			segments[j] = toSnake(segment)
		}
		return strings.Join(append(segments, identType), "::"), true
	}
	return "", false
}
