//go:build !js

package srpc

import (
	"context"
	"io"
	"net/http"

	"github.com/coder/websocket"
)

// HTTPServer implements the SRPC HTTP/WebSocket server.
//
// NOTE: accepting websocket connections is stubbed out on GOOS=js!
type HTTPServer struct {
	mux        Mux
	srpc       *Server
	path       string
	acceptOpts *websocket.AcceptOptions
}

// NewHTTPServer builds a http server / handler.
// if path is empty, serves on all routes.
func NewHTTPServer(mux Mux, path string, acceptOpts *websocket.AcceptOptions) (*HTTPServer, error) {
	return &HTTPServer{
		mux:        mux,
		srpc:       NewServer(mux),
		path:       path,
		acceptOpts: acceptOpts,
	}, nil
}

func (s *HTTPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.path != "" && r.URL.Path != s.path {
		return
	}

	c, err := websocket.Accept(w, r, s.acceptOpts)
	if err != nil {
		// NOTE: the error is already written with http.Error
		// w.WriteHeader(500)
		// _, _ = w.Write([]byte(err.Error() + "\n"))
		return
	}
	defer c.Close(websocket.StatusInternalError, "closed")

	ctx := r.Context()
	wsConn, err := NewWebSocketConn(ctx, c, true, nil)
	if err != nil {
		c.Close(websocket.StatusInternalError, err.Error())
		return
	}

	// handle incoming streams
	for {
		strm, err := wsConn.AcceptStream()
		if err != nil {
			if err != io.EOF && err != context.Canceled {
				// TODO: handle / log error?
				c.Close(websocket.StatusInternalError, err.Error())
			}
			return
		}
		go s.srpc.HandleStream(ctx, strm)
	}
}
