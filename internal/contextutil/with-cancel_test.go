package contextutil

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestWithCancelParentCancelPropagates(t *testing.T) {
	parent, parentCancel := context.WithCancel(context.Background())
	ctx, cancel := WithCancel(parent)
	defer cancel()

	parentCancel()

	select {
	case <-ctx.Done():
	case <-t.Context().Done():
		t.Fatal("timed out waiting for parent cancellation")
	}
	if got := ctx.Err(); got != context.Canceled {
		t.Fatalf("err mismatch: got %v want %v", got, context.Canceled)
	}
}

func TestWithCancelAlreadyCanceledParent(t *testing.T) {
	parent, parentCancel := context.WithCancel(context.Background())
	parentCancel()

	ctx, cancel := WithCancel(parent)
	defer cancel()

	select {
	case <-ctx.Done():
	default:
		t.Fatal("expected already-canceled parent to cancel child")
	}
	if got := ctx.Err(); got != context.Canceled {
		t.Fatalf("err mismatch: got %v want %v", got, context.Canceled)
	}
}

func TestWithCancelParentCausePropagates(t *testing.T) {
	cause := errors.New("parent canceled")
	parent, parentCancel := context.WithCancelCause(context.Background())
	ctx, cancel := WithCancel(parent)
	defer cancel()

	parentCancel(cause)

	select {
	case <-ctx.Done():
	case <-t.Context().Done():
		t.Fatal("timed out waiting for parent cancellation")
	}
	if got := context.Cause(ctx); got != cause {
		t.Fatalf("cause mismatch: got %v want %v", got, cause)
	}
	if got := ctx.Err(); got != context.Canceled {
		t.Fatalf("err mismatch: got %v want %v", got, context.Canceled)
	}
}

func TestWithCancelLocalCancelLeavesParentAlive(t *testing.T) {
	parent := t.Context()

	ctx, cancel := WithCancel(parent)
	cancel()

	select {
	case <-ctx.Done():
	case <-t.Context().Done():
		t.Fatal("timed out waiting for local cancellation")
	}

	select {
	case <-parent.Done():
		t.Fatal("local cancellation canceled parent")
	default:
	}
}

func TestWithCancelPreservesDeadline(t *testing.T) {
	deadline := time.Now().Add(time.Hour)
	parent, parentCancel := context.WithDeadline(context.Background(), deadline)
	defer parentCancel()

	ctx, cancel := WithCancel(parent)
	defer cancel()

	got, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected deadline")
	}
	if !got.Equal(deadline) {
		t.Fatalf("deadline mismatch: got %v want %v", got, deadline)
	}
}

func TestWithCancelParentDeadlineCausePropagates(t *testing.T) {
	cause := errors.New("parent deadline")
	parent, parentCancel := context.WithDeadlineCause(context.Background(), time.Now().Add(time.Millisecond), cause)
	defer parentCancel()

	ctx, cancel := WithCancel(parent)
	defer cancel()

	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for parent deadline")
	}
	if got := context.Cause(ctx); got != cause {
		t.Fatalf("cause mismatch: got %v want %v", got, cause)
	}
	if got := ctx.Err(); got != context.DeadlineExceeded {
		t.Fatalf("err mismatch: got %v want %v", got, context.DeadlineExceeded)
	}
}
