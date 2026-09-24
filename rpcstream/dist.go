//go:build !js && !tinygo

package rpcstream

import "embed"

// DistSources contains the TypeScript rpcstream messages for the web.
//
//go:embed rpcstream.pb.ts
var DistSources embed.FS
