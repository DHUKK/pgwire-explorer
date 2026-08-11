package pgproto

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"testing"
)

// annotatedMessageNames returns every pgproto3 message type that annotate.go
// has an explicit case for, by parsing the file rather than by keeping a
// hand-maintained list beside it. A list would drift the moment someone adds a
// case, which is exactly the drift the coverage check exists to catch.
//
// It looks for `case *pgproto3.Foo:` (and multi-type cases like
// `case *pgproto3.Flush, *pgproto3.Sync:`) anywhere in the file.
func annotatedMessageNames() []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "annotate.go", nil, 0)
	if err != nil {
		// Reported by the caller as a test failure. Returning nil here would
		// silently pass the coverage check instead.
		panic("parse annotate.go: " + err.Error())
	}

	seen := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		clause, ok := n.(*ast.CaseClause)
		if !ok {
			return true
		}
		for _, expr := range clause.List {
			star, ok := expr.(*ast.StarExpr)
			if !ok {
				continue
			}
			sel, ok := star.X.(*ast.SelectorExpr)
			if !ok {
				continue
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "pgproto3" {
				continue
			}
			seen[sel.Sel.Name] = true
		}
		return true
	})

	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// TestAnnotatedMessageNamesFound guards the guard: if the AST walk above ever
// stops finding cases (renamed import, restructured switch), the coverage
// subtest in TestAnnotateInvariants would vacuously pass.
func TestAnnotatedMessageNamesFound(t *testing.T) {
	names := annotatedMessageNames()
	if len(names) < 40 {
		t.Fatalf("found only %d annotated message types (%v). The AST walk is probably broken", len(names), names)
	}
	t.Logf("annotate.go handles %d message types", len(names))
}
