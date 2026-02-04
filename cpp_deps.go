//go:build deps_only
// +build deps_only

package starpc

import (
	// _ imports C++ dependency packages to vendor their CMake files
	_ "github.com/aperturerobotics/abseil-cpp"
	// _ imports C++ dependency packages to vendor their CMake files
	_ "github.com/aperturerobotics/protobuf"
)
