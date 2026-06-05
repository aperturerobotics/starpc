package starpc

import (
	"io/fs"
	"os"
	"path"
	"strings"
	"testing"
)

func TestNoRawPrintlnDebugInstrumentation(t *testing.T) {
	for _, root := range []string{"srpc", "rpcstream"} {
		srcRoot, err := os.OpenRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		defer srcRoot.Close()

		err = fs.WalkDir(srcRoot.FS(), ".", func(name string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				return nil
			}
			data, err := srcRoot.ReadFile(name)
			if err != nil {
				return err
			}
			if strings.Contains(string(data), "println(") {
				t.Errorf("%s contains raw println debug output", path.Join(root, name))
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
