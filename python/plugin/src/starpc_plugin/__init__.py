__all__ = ["main"]

import sys

from google.protobuf.compiler import plugin_pb2


def main() -> None:
    request = plugin_pb2.CodeGeneratorRequest()
    request.ParseFromString(sys.stdin.buffer.read())
    response = plugin_pb2.CodeGeneratorResponse(
        error="starpc-python plugin is not implemented"
    )
    sys.stdout.buffer.write(response.SerializeToString())
