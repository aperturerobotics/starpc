package starpc

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoRawPrintlnDebugInstrumentation(t *testing.T) {
	for _, root := range []string{"srpc", "rpcstream"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(data), "println(") {
				t.Errorf("%s contains raw println debug output", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
