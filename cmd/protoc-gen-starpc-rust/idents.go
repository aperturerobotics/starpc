package main

import (
	"strings"
	"unicode"
)

// This file ports the identifier rules of prost-build 0.14 (ident.rs) and of
// the heck 0.5 case conversions it uses, so that generated service bindings
// name the Rust items of the message files exactly as Prost does. The port is
// licensed as LICENSE.prost-build (Apache-2.0) and LICENSE.heck (MIT).

// wordMode is the case of the previous characters while splitting a word.
type wordMode int

const (
	// modeBoundary follows a word boundary, before any cased character.
	modeBoundary wordMode = iota
	// modeLowercase follows a lowercase character.
	modeLowercase
	// modeUppercase follows an uppercase character.
	modeUppercase
)

// splitWords splits s into words the way heck does: at every character that is
// not alphanumeric, where a lowercase character meets an uppercase one, and
// before the last uppercase character of a run that precedes a lowercase one.
func splitWords(s string) []string {
	var words []string
	segments := strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})

	for _, segment := range segments {
		runes := []rune(segment)
		start := 0
		mode := modeBoundary

		// Scan each character together with the one that follows it.
		for i, c := range runes {
			if i == len(runes)-1 {
				words = append(words, string(runes[start:]))
				break
			}

			next := runes[i+1]
			nextMode := mode
			switch {
			case unicode.IsLower(c):
				nextMode = modeLowercase
			case unicode.IsUpper(c):
				nextMode = modeUppercase
			}

			switch {
			case nextMode == modeLowercase && unicode.IsUpper(next):
				// A lowercase character is followed by an uppercase one.
				words = append(words, string(runes[start:i+1]))
				start = i + 1
				mode = modeBoundary
			case mode == modeUppercase && unicode.IsUpper(c) && unicode.IsLower(next):
				// The last uppercase character of a run starts the next word.
				words = append(words, string(runes[start:i]))
				start = i
				mode = modeBoundary
			default:
				mode = nextMode
			}
		}
	}
	return words
}

// sanitizeIdentifier makes s usable as a Rust identifier. A keyword becomes a
// raw identifier, a keyword that cannot be raw gets a trailing underscore, and
// a leading digit gets a leading underscore.
func sanitizeIdentifier(s string) string {
	switch s {
	case "as", "break", "const", "continue", "else", "enum", "false", "fn",
		"for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
		"pub", "ref", "return", "static", "struct", "trait", "true", "type",
		"unsafe", "use", "where", "while", "dyn", "abstract", "become", "box",
		"do", "final", "macro", "override", "priv", "typeof", "unsized",
		"virtual", "yield", "async", "await", "try", "gen":
		return "r#" + s
	case "_", "super", "self", "Self", "extern", "crate":
		return s + "_"
	}
	if r := []rune(s); len(r) != 0 && unicode.IsNumber(r[0]) {
		return "_" + s
	}
	return s
}

// snakeCase converts s to lower_snake_case without keyword handling.
func snakeCase(s string) string {
	words := splitWords(s)
	for i, word := range words {
		words[i] = strings.ToLower(word)
	}
	return strings.Join(words, "_")
}

// toSnake converts a protobuf identifier to a Rust field, method, or module
// identifier.
func toSnake(s string) string {
	return sanitizeIdentifier(snakeCase(s))
}

// upperCamelCase converts s to UpperCamelCase without keyword handling.
func upperCamelCase(s string) string {
	var out strings.Builder
	for _, word := range splitWords(s) {
		runes := []rune(word)
		out.WriteRune(unicode.ToUpper(runes[0]))
		out.WriteString(strings.ToLower(string(runes[1:])))
	}
	return out.String()
}

// toUpperCamel converts a protobuf identifier to a Rust type identifier.
func toUpperCamel(s string) string {
	return sanitizeIdentifier(upperCamelCase(s))
}

// screamingSnakeCase separates uppercase transitions of an UpperCamelCase name
// with underscores and uppercases it, as the Rust service generator does for
// service and method identity constants.
func screamingSnakeCase(name string) string {
	var out strings.Builder
	for i, r := range name {
		if unicode.IsUpper(r) && i != 0 {
			out.WriteByte('_')
		}
		out.WriteRune(unicode.ToUpper(r))
	}
	return out.String()
}
