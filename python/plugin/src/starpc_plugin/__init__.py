__all__ = ["generate", "main"]

import sys

from google.protobuf.compiler import plugin_pb2
from google.protobuf.message import DecodeError

from .generator import generate


def main() -> None:
    request = plugin_pb2.CodeGeneratorRequest()
    try:
        request.ParseFromString(sys.stdin.buffer.read())
    except DecodeError as exc:
        response = plugin_pb2.CodeGeneratorResponse(error=f"invalid request: {exc}")
    else:
        response = generate(request)
    sys.stdout.buffer.write(response.SerializeToString(deterministic=True))
