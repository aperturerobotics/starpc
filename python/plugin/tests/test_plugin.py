import subprocess
import sys
import unittest

from google.protobuf.compiler import plugin_pb2


class PluginTest(unittest.TestCase):
    def test_distribution_separation_and_error_handshake(self) -> None:
        request = plugin_pb2.CodeGeneratorRequest(file_to_generate=["echo.proto"])
        proc = subprocess.run(
            [sys.executable, "-m", "starpc_plugin"],
            input=request.SerializeToString(),
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0)
        response = plugin_pb2.CodeGeneratorResponse.FromString(proc.stdout)
        self.assertIn("not implemented", response.error)


if __name__ == "__main__":
    unittest.main()
