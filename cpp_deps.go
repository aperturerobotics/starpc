//go:build deps_only
// +build deps_only

package starpc

import (
	// Import C++ dependency packages to vendor their CMake files
	_ "github.com/aperturerobotics/abseil-cpp"
	_ "github.com/aperturerobotics/protobuf"
)
