//go:build !goscript

package srpc

func startServerRPCInvoke(fn func()) {
	go fn()
}
