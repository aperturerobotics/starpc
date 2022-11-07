package srpc

import (
	"context"
	"io"
	"net/http"

	"nhooyr.io/websocket"
)

// HTTPServer implements the SRPC server.
type HTTPServer struct {
	mux  Mux
	srpc *Server
	path string
}

// NewHTTPServer builds a http server / handler.
// if path is empty, serves on all routes.
func NewHTTPServer(mux Mux, path string) (*HTTPServer, error) {
	return &HTTPServer{
		mux:  mux,
		srpc: NewServer(mux),
		path: path,
	}, nil
}

func (s *HTTPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.path != "" && r.URL.Path != s.path {
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
	if err != nil {
		w.WriteHeader(500)
		w.Write([]byte(err.Error() + "\n"))
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
		go func() {
			err := s.srpc.HandleStream(ctx, strm)
			_ = err
			// TODO: handle / log error?
			// err != nil && err != io.EOF && err != context.Canceled
		}()
	}
}
