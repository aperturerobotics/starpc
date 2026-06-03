//go:build goscript

package srpc

import (
	"testing"
	"time"
)

func TestStartServerRPCInvokeDefersGoscriptWork(t *testing.T) {
	ran := make(chan struct{}, 1)
	startServerRPCInvoke(func() {
		ran <- struct{}{}
	})

	select {
	case <-ran:
		t.Fatal("server rpc invoke ran inline")
	default:
	}

	select {
	case <-ran:
	case <-time.After(time.Second):
		t.Fatal("server rpc invoke did not run")
	}
}
