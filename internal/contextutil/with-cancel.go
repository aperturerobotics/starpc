//go:build !tinygo

package contextutil

import "context"

// WithCancel returns a cancelable child context.
func WithCancel(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}
