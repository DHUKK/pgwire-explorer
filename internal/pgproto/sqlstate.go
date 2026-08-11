package pgproto

// SQLSTATE decoding.
//
// An ErrorResponse carries its SQLSTATE as five characters in field `C`, and
// that code is the part a client should program against: 23505 always means a
// unique violation whatever language the message is in. Showing the raw digits
// and leaving the reader to look them up wastes the one field that is designed
// to be machine-readable, so the annotation names the condition.
//
// The names are the condition names from Appendix A of the Postgres manual, the
// same identifiers PL/pgSQL uses in an EXCEPTION clause. The list below is the
// common subset. Anything not in it falls back to its class, taken from the
// first two characters, so every possible code still decodes to something
// useful.

// SQLStateName returns a human name for a five-character SQLSTATE.
//
// It returns the condition name when the exact code is known, otherwise a
// description of the code's class, otherwise "" for anything that is not five
// characters.
func SQLStateName(code string) string {
	if len(code) != 5 {
		return ""
	}
	if name, ok := sqlStateConditions[code]; ok {
		return name
	}
	if class, ok := sqlStateClasses[code[:2]]; ok {
		return "class " + code[:2] + ": " + class
	}
	return ""
}

// sqlStateConditions are the codes worth naming exactly. Weighted towards what
// actually shows up in application logs.
var sqlStateConditions = map[string]string{
	// Class 00, 01, 02: success, warning, no data
	"00000": "successful_completion",
	"01000": "warning",
	"02000": "no_data",

	// Class 08: connection exception
	"08000": "connection_exception",
	"08003": "connection_does_not_exist",
	"08006": "connection_failure",
	"08P01": "protocol_violation",

	// Class 22: data exception
	"22000": "data_exception",
	"22001": "string_data_right_truncation",
	"22003": "numeric_value_out_of_range",
	"22004": "null_value_not_allowed",
	"22007": "invalid_datetime_format",
	"22008": "datetime_field_overflow",
	"22012": "division_by_zero",
	"2201B": "invalid_regular_expression",
	"22023": "invalid_parameter_value",
	"22P02": "invalid_text_representation",
	"22P05": "untranslatable_character",

	// Class 23: integrity constraint violation
	"23000": "integrity_constraint_violation",
	"23001": "restrict_violation",
	"23502": "not_null_violation",
	"23503": "foreign_key_violation",
	"23505": "unique_violation",
	"23514": "check_violation",
	"23P01": "exclusion_violation",

	// Class 25: invalid transaction state
	"25000": "invalid_transaction_state",
	"25001": "active_sql_transaction",
	"25006": "read_only_sql_transaction",
	"25P01": "no_active_sql_transaction",
	"25P02": "in_failed_sql_transaction",
	"25P03": "idle_in_transaction_session_timeout",

	// Class 28: invalid authorization specification
	"28000": "invalid_authorization_specification",
	"28P01": "invalid_password",

	// Class 3D, 3F: invalid catalog / schema name
	"3D000": "invalid_catalog_name",
	"3F000": "invalid_schema_name",

	// Class 40: transaction rollback
	"40000": "transaction_rollback",
	"40001": "serialization_failure",
	"40003": "statement_completion_unknown",
	"40P01": "deadlock_detected",

	// Class 42: syntax error or access rule violation
	"42000": "syntax_error_or_access_rule_violation",
	"42501": "insufficient_privilege",
	"42601": "syntax_error",
	"42602": "invalid_name",
	"42622": "name_too_long",
	"42701": "duplicate_column",
	"42702": "ambiguous_column",
	"42703": "undefined_column",
	"42704": "undefined_object",
	"42710": "duplicate_object",
	"42712": "duplicate_alias",
	"42723": "duplicate_function",
	"42725": "ambiguous_function",
	"42803": "grouping_error",
	"42804": "datatype_mismatch",
	"42809": "wrong_object_type",
	"42830": "invalid_foreign_key",
	"42846": "cannot_coerce",
	"42883": "undefined_function",
	"42939": "reserved_name",
	"42P01": "undefined_table",
	"42P02": "undefined_parameter",
	"42P07": "duplicate_table",
	"42P18": "indeterminate_datatype",

	// Class 53: insufficient resources
	"53000": "insufficient_resources",
	"53100": "disk_full",
	"53200": "out_of_memory",
	"53300": "too_many_connections",

	// Class 54: program limit exceeded
	"54000": "program_limit_exceeded",
	"54001": "statement_too_complex",
	"54011": "too_many_columns",

	// Class 55: object not in prerequisite state
	"55000": "object_not_in_prerequisite_state",
	"55006": "object_in_use",
	"55P03": "lock_not_available",

	// Class 57: operator intervention
	"57000": "operator_intervention",
	"57014": "query_canceled",
	"57P01": "admin_shutdown",
	"57P02": "crash_shutdown",
	"57P03": "cannot_connect_now",
	"57P04": "database_dropped",

	// Class 58: system error
	"58000": "system_error",
	"58030": "io_error",

	// Class XX: internal error
	"XX000": "internal_error",
	"XX001": "data_corrupted",
	"XX002": "index_corrupted",
}

// sqlStateClasses describe every class in Appendix A, so a code with no exact
// entry above still decodes to the kind of problem it is.
var sqlStateClasses = map[string]string{
	"00": "successful completion",
	"01": "warning",
	"02": "no data",
	"03": "SQL statement not yet complete",
	"08": "connection exception",
	"09": "triggered action exception",
	"0A": "feature not supported",
	"0B": "invalid transaction initiation",
	"0F": "locator exception",
	"0L": "invalid grantor",
	"0P": "invalid role specification",
	"0Z": "diagnostics exception",
	"20": "case not found",
	"21": "cardinality violation",
	"22": "data exception",
	"23": "integrity constraint violation",
	"24": "invalid cursor state",
	"25": "invalid transaction state",
	"26": "invalid SQL statement name",
	"27": "triggered data change violation",
	"28": "invalid authorization specification",
	"2B": "dependent privilege descriptors still exist",
	"2D": "invalid transaction termination",
	"2F": "SQL routine exception",
	"34": "invalid cursor name",
	"38": "external routine exception",
	"39": "external routine invocation exception",
	"3B": "savepoint exception",
	"3D": "invalid catalog name",
	"3F": "invalid schema name",
	"40": "transaction rollback",
	"42": "syntax error or access rule violation",
	"44": "WITH CHECK OPTION violation",
	"53": "insufficient resources",
	"54": "program limit exceeded",
	"55": "object not in prerequisite state",
	"57": "operator intervention",
	"58": "system error",
	"72": "snapshot failure",
	"F0": "configuration file error",
	"HV": "foreign data wrapper error",
	"P0": "PL/pgSQL error",
	"XX": "internal error",
}
