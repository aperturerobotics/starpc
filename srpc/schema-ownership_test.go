package srpc

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// handwrittenTerminalConst names the parallel iota constants the receipt
// post-mortem removed. Their reappearance signals a second handwritten owner of
// the cross-language terminal vocabulary.
var handwrittenTerminalConst = map[string]bool{
	"TerminalCommitted": true,
	"TerminalCanceled":  true,
	"TerminalLost":      true,
	"TerminalClosed":    true,
	"TerminalAbandoned": true,
}

// handwrittenTerminalKindOwners returns the source files that declare the shared
// TerminalKind vocabulary by hand instead of consuming the generated rpcproto
// owner. The cross-language terminal noun has exactly one schema owner; a
// handwritten type or iota constant reintroduces the parallel owner.
func handwrittenTerminalKindOwners(t *testing.T, files map[string]string) []string {
	t.Helper()
	var owners []string
	for name, src := range files {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		if declaresTerminalKindByHand(file) {
			owners = append(owners, name)
		}
	}
	return owners
}

// declaresTerminalKindByHand reports whether a file declares the TerminalKind
// type or one of its removed iota constants.
func declaresTerminalKindByHand(file *ast.File) bool {
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok {
			continue
		}
		for _, spec := range gen.Specs {
			switch s := spec.(type) {
			case *ast.TypeSpec:
				if s.Name.Name == "TerminalKind" {
					return true
				}
			case *ast.ValueSpec:
				for _, id := range s.Names {
					if handwrittenTerminalConst[id.Name] {
						return true
					}
				}
			}
		}
	}
	return false
}

// packageSourceFiles reads the non-generated, non-test Go sources of the current
// package directory.
func packageSourceFiles(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	files := map[string]string{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		if strings.HasSuffix(name, ".pb.go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		files[name] = string(data)
	}
	return files
}

// TestTerminalKindHasSingleSchemaOwner proves no handwritten srpc source owns
// the cross-language TerminalKind vocabulary alongside the generated owner.
func TestTerminalKindHasSingleSchemaOwner(t *testing.T) {
	owners := handwrittenTerminalKindOwners(t, packageSourceFiles(t))
	if len(owners) != 0 {
		t.Fatalf("TerminalKind must come from generated rpcproto; handwritten owners: %v", owners)
	}
}

// TestTerminalKindGuardDetectsHandwrittenOwner proves the guard fires when a
// parallel handwritten TerminalKind owner regresses into the package.
func TestTerminalKindGuardDetectsHandwrittenOwner(t *testing.T) {
	bad := map[string]string{
		"server-invocation.go": "package srpc\n\n" +
			"type TerminalKind int\n\n" +
			"const (\n\tTerminalCommitted TerminalKind = iota\n)\n",
	}
	if owners := handwrittenTerminalKindOwners(t, bad); len(owners) == 0 {
		t.Fatal("guard failed to flag a handwritten TerminalKind owner")
	}
}
