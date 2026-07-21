package srpc

import (
	"net"
	"os"
	"sync"
	"testing"
)

func TestNewMuxedConnConcurrentConfigIsolation(t *testing.T) {
	first := NewYamuxConfig()
	second := NewYamuxConfig()
	if first == second {
		t.Fatal("NewYamuxConfig returned a shared config")
	}
	first.AcceptBacklog++
	if first.AcceptBacklog == second.AcceptBacklog {
		t.Fatal("mutating one yamux config changed another")
	}

	// go-yamux's default config reads os.Stderr. Starpc discards yamux logs, so
	// constructing a connection must not observe concurrent stderr replacement.
	originalStderr := os.Stderr
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()

	stopReplacingStderr := make(chan struct{})
	var replaceStderr sync.WaitGroup
	replaceStderr.Go(func() {
		for {
			select {
			case <-stopReplacingStderr:
				return
			default:
				os.Stderr = devNull
				os.Stderr = originalStderr
			}
		}
	})

	const iterations = 100
	start := make(chan struct{})
	errs := make(chan error, 2)
	var builders sync.WaitGroup
	builders.Add(2)
	for range 2 {
		go func() {
			defer builders.Done()
			<-start
			for range iterations {
				conn, peer := net.Pipe()
				muxed, err := NewMuxedConn(conn, false, nil)
				if err == nil {
					err = muxed.Close()
				} else {
					_ = conn.Close()
				}
				_ = peer.Close()
				if err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	close(start)
	builders.Wait()
	close(stopReplacingStderr)
	replaceStderr.Wait()
	os.Stderr = originalStderr
	close(errs)

	for err := range errs {
		t.Fatal(err)
	}
}
