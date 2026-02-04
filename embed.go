//go:build deps_only
// +build deps_only

package starpc

import "embed"

// SourceFiles contains .cpp .hpp .rs and .ts files in the implementation.
// This forces Go to vendor these files to vendor/
//
//go:embed srpc/*.hpp srpc/*.cpp srpc/*.rs srpc/*.ts
//go:embed rpcstream/*.hpp rpcstream/*.cpp rpcstream/*.rs rpcstream/*.ts
var SourceFiles embed.FS
