package integration

import (
	"context"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/aperturerobotics/starpc/echo"
	"github.com/aperturerobotics/starpc/srpc"
)

// processPipe joins the separate stdin/stdout handles used by the native process.
type processPipe struct {
	// input carries packets to the child.
	input io.WriteCloser
	// output carries replies from the child.
	output io.ReadCloser
}

// Read receives framed data from the child.
func (p *processPipe) Read(data []byte) (int, error) { return p.output.Read(data) }

// Write sends framed data to the child.
func (p *processPipe) Write(data []byte) (int, error) { return p.input.Write(data) }

// Close interrupts both directions of the child connection.
func (p *processPipe) Close() error {
	inputErr := p.input.Close()
	outputErr := p.output.Close()
	if inputErr != nil {
		return inputErr
	}
	return outputErr
}

func TestCppProcessPipe(t *testing.T) {
	binary := os.Getenv("STARPC_CPP_PIPE_SERVER")
	if binary == "" {
		t.Skip("set STARPC_CPP_PIPE_SERVER to the compiled C++ pipe server")
	}
	for _, abrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "disconnect"}[abrupt], func(t *testing.T) {
			// Start a real C++ process with the same pipe framing used by Go.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			t.Cleanup(cancel)
			cmd := exec.CommandContext(ctx, binary)
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			connection := &processPipe{input: input, output: output}
			transport := srpc.NewPacketReadWriter(connection)
			readerDone := make(chan struct{})
			client := srpc.NewClient(func(_ context.Context, handler srpc.PacketDataHandler, closed srpc.CloseHandler) (srpc.PacketWriter, error) {
				go func() {
					defer close(readerDone)
					transport.ReadPump(handler, closed)
				}()
				return transport, nil
			})
			t.Cleanup(func() {
				_ = connection.Close()
				<-readerDone
				if err := cmd.Wait(); err != nil {
					t.Errorf("C++ process shutdown: %v", err)
				}
			})

			// Successive requests use the same running process and generated API.
			stream, err := echo.NewSRPCEchoerClient(client).EchoBidiStream(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			for _, body := range []string{"", "initial setup", "apply another activity"} {
				if err := stream.MsgSend(&echo.EchoMsg{Body: body}); err != nil {
					t.Fatal(err)
				}
				reply, err := stream.Recv()
				if err != nil {
					t.Fatal(err)
				}
				if reply.Body != body {
					t.Fatalf("reply %q, wanted %q", reply.Body, body)
				}
			}

			// An explicit half-close completes normally; a dropped pipe cancels the
			// blocked C++ handler and process destruction joins it.
			if abrupt {
				_ = connection.Close()
				return
			}
			if err := stream.CloseSend(); err != nil {
				t.Fatal(err)
			}
			if _, err := stream.Recv(); err != io.EOF {
				t.Fatalf("completion returned %v", err)
			}
		})
	}
}

var _ io.ReadWriteCloser = (*processPipe)(nil)
