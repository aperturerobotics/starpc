package srpc

import "strings"

// CheckStripPrefix checks if the string has any of the given prefixes and
// strips the matched prefix if any.
//
// if len(matchPrefixes) == 0 returns the ID without changing it.
func CheckStripPrefix(id string, matchPrefixes []string) (strippedID string, matchedPrefix string) {
	if len(matchPrefixes) == 0 {
		return id, ""
	}

	var matched bool
	for _, prefix := range matchPrefixes {
		matched = strings.HasPrefix(id, prefix)
		if matched {
			matchedPrefix = prefix
			break
		}
	}
	if !matched {
		return id, ""
	}
	return id[len(matchedPrefix):], matchedPrefix
}
