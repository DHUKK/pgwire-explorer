package pgproto

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgproto3"
)

func TestSQLStateName(t *testing.T) {
	tests := []struct {
		code string
		want string
	}{
		{"23505", "unique_violation"},
		{"42P01", "undefined_table"},
		{"57014", "query_canceled"},
		{"40P01", "deadlock_detected"},
		{"28P01", "invalid_password"},
		{"00000", "successful_completion"},

		// Not in the exact list, so it falls back to its class. Every code
		// decodes to something rather than to five bare digits.
		{"42P99", "class 42: syntax error or access rule violation"},
		{"22P99", "class 22: data exception"},
		{"P0001", "class P0: PL/pgSQL error"},

		// Not a SQLSTATE at all.
		{"", ""},
		{"123", ""},
		{"ZZ999", ""},
	}

	for _, tc := range tests {
		if got := SQLStateName(tc.code); got != tc.want {
			t.Errorf("SQLStateName(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}

// TestSQLStateInAnnotation checks the decoded name reaches the field a reader
// sees, and that the raw five characters are still there underneath.
func TestSQLStateInAnnotation(t *testing.T) {
	raw := encode(t, &pgproto3.ErrorResponse{
		Severity: "ERROR",
		Code:     "23505",
		Message:  "duplicate key value violates unique constraint",
	})

	d := Decode(ServerToClient, raw, 0)
	group := find(t, d.Fields, "Fields")

	var entry *FieldAnnotation
	for i := range group.Children {
		if strings.HasSuffix(group.Children[i].Name, "(C)") {
			entry = &group.Children[i]
		}
	}
	if entry == nil {
		t.Fatal("no SQLSTATE field in the annotation")
	}

	if got, want := entry.Value, "23505 (unique_violation)"; got != want {
		t.Errorf("SQLSTATE field value = %v, want %q", got, want)
	}

	// The child holds what was actually on the wire, undecorated, so the byte
	// range and the value still agree.
	if got := find(t, entry.Children, "Value").Value; got != "23505" {
		t.Errorf("raw value = %v, want %q", got, "23505")
	}
}

// TestSQLStateClassesCoverKnownCodes keeps the two tables consistent: every exact
// condition's class must also be described, or a near-miss code would decode to
// nothing.
func TestSQLStateClassesCoverKnownCodes(t *testing.T) {
	for code := range sqlStateConditions {
		if _, ok := sqlStateClasses[code[:2]]; !ok {
			t.Errorf("condition %s has no entry for class %s", code, code[:2])
		}
	}
}

func find(t *testing.T, fields []FieldAnnotation, name string) FieldAnnotation {
	t.Helper()
	for _, f := range fields {
		if f.Name == name {
			return f
		}
	}
	t.Fatalf("no field named %q", name)
	return FieldAnnotation{}
}
