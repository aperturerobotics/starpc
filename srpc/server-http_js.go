//go:build js

package srpc

import "errors"

// HTTPServer implements the SRPC HTTP/WebSocket server.
//
// NOTE: accepting websocket connections is stubbed out on GOOS=js!
type HTTPServer struct{}

// NewHTTPServer builds a http server / handler.
func NewHTTPServer(mux Mux, path string) (*HTTPServer, error) {
	return nil, errors.New("srpc: http server not implemented on js")
}

// stub for js
func (s *HTTPServer) ServeHTTP(w any, r any) {}
