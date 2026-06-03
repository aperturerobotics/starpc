//go:build goscript

package srpc

import "time"

func startServerRPCInvoke(fn func()) {
	if fn == nil {
		return
	}
	time.AfterFunc(0, fn)
}
