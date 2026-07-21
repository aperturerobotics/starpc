package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"testing"
)

// forbiddenFixtureCalls names the pipeline constructors that rebuild a second
// srpc server inside a fixture. The receipt post-mortem removed a hand-built
// ReadPump pipeline; the fixture must drive one srpc.Server through one
// Server.HandleStream and observe framed packets by decorating net.Conn.
var forbiddenFixtureCalls = []string{"NewServerRPC", "NewPacketReadWriter", "ReadPump"}

// fixtureOwnerViolations returns the ways a cross-language Go fixture source
// diverges from the single production server owner.
func fixtureOwnerViolations(src string) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "fixture.go", src, 0)
	if err != nil {
		return []string{"parse error: " + err.Error()}
	}

	seen := map[string]bool{}
	handleStreamCalls := 0
	newServerCalls := 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		switch sel.Sel.Name {
		case "HandleStream":
			handleStreamCalls++
		case "NewServer":
			newServerCalls++
		case "NewServerRPC", "NewPacketReadWriter", "ReadPump":
			seen[sel.Sel.Name] = true
		}
		return true
	})

	var violations []string
	for _, name := range forbiddenFixtureCalls {
		if seen[name] {
			violations = append(violations, "reconstructs server pipeline via "+name)
		}
	}
	if newServerCalls != 1 {
		violations = append(violations, "expected exactly one srpc.NewServer, found "+strconv.Itoa(newServerCalls))
	}
	if handleStreamCalls != 1 {
		violations = append(violations, "expected exactly one Server.HandleStream entrypoint, found "+strconv.Itoa(handleStreamCalls))
	}
	if !decoratesNetConn(file) {
		violations = append(violations, "no fixture type decorates net.Conn")
	}
	return violations
}

// decoratesNetConn reports whether the source embeds net.Conn in a struct, the
// only sanctioned way for fixture instrumentation to observe framed packets.
func decoratesNetConn(file *ast.File) bool {
	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		st, ok := n.(*ast.StructType)
		if !ok {
			return true
		}
		for _, field := range st.Fields.List {
			if len(field.Names) != 0 {
				continue
			}
			sel, ok := field.Type.(*ast.SelectorExpr)
			if !ok {
				continue
			}
			pkg, ok := sel.X.(*ast.Ident)
			if ok && pkg.Name == "net" && sel.Sel.Name == "Conn" {
				found = true
			}
		}
		return true
	})
	return found
}

// TestFixtureUsesSingleServerOwner proves the shipped fixture drives one
// srpc.Server through one Server.HandleStream and decorates net.Conn.
func TestFixtureUsesSingleServerOwner(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if violations := fixtureOwnerViolations(string(src)); len(violations) != 0 {
		t.Fatalf("fixture diverged from single server owner: %v", violations)
	}
}

// TestFixtureGuardDetectsSecondPipeline proves the guard fires when a fixture
// rebuilds a second RPC server pipeline.
func TestFixtureGuardDetectsSecondPipeline(t *testing.T) {
	bad := `package main

import (
	"net"

	"github.com/aperturerobotics/starpc/srpc"
)

func run(conn net.Conn) {
	prw := srpc.NewPacketReadWriter(conn)
	rpc := srpc.NewServerRPC(nil, nil)
	_ = rpc.ReadPump(prw)
}
`
	if violations := fixtureOwnerViolations(bad); len(violations) == 0 {
		t.Fatal("guard failed to flag a second server pipeline")
	}
}
