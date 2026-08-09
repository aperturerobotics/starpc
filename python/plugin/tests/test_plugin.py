from __future__ import annotations

import ast
import subprocess
import sys
import unittest
from pathlib import Path

from google.protobuf import descriptor_pb2
from google.protobuf.compiler import plugin_pb2
from starpc_plugin import generate

ROOT = Path(__file__).parent
GOLDEN = ROOT / "golden"


class PluginTest(unittest.TestCase):
    def request(
        self, *, parameter: str = "", target: str = "acme/echo.proto"
    ) -> plugin_pb2.CodeGeneratorRequest:
        dependency = descriptor_pb2.FileDescriptorProto(
            name="acme/common.proto",
            package="acme",
            syntax="proto3",
            message_type=[descriptor_pb2.DescriptorProto(name="Shared")],
        )
        target_file = descriptor_pb2.FileDescriptorProto(
            name="acme/echo.proto",
            package="acme",
            syntax="proto3",
            dependency=[dependency.name],
            message_type=[
                descriptor_pb2.DescriptorProto(name="Request"),
                descriptor_pb2.DescriptorProto(name="Response"),
            ],
            service=[
                descriptor_pb2.ServiceDescriptorProto(
                    name="Echo",
                    method=[
                        descriptor_pb2.MethodDescriptorProto(
                            name="Unary",
                            input_type=".acme.Request",
                            output_type=".acme.Response",
                        ),
                        descriptor_pb2.MethodDescriptorProto(
                            name="ServerStream",
                            input_type=".acme.Request",
                            output_type=".acme.Response",
                            server_streaming=True,
                        ),
                        descriptor_pb2.MethodDescriptorProto(
                            name="ClientStream",
                            input_type=".acme.Request",
                            output_type=".acme.Response",
                            client_streaming=True,
                        ),
                        descriptor_pb2.MethodDescriptorProto(
                            name="Bidi",
                            input_type=".acme.Shared",
                            output_type=".acme.Shared",
                            client_streaming=True,
                            server_streaming=True,
                        ),
                    ],
                )
            ],
        )
        return plugin_pb2.CodeGeneratorRequest(
            file_to_generate=[target],
            proto_file=[dependency, target_file],
            parameter=parameter,
        )

    def run_plugin(
        self, request: plugin_pb2.CodeGeneratorRequest
    ) -> plugin_pb2.CodeGeneratorResponse:
        proc = subprocess.run(
            [sys.executable, "-m", "starpc_plugin"],
            input=request.SerializeToString(),
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        try:
            return plugin_pb2.CodeGeneratorResponse.FromString(proc.stdout)
        except Exception as exc:  # noqa: BLE001
            self.fail(
                f"plugin handshake returned malformed CodeGeneratorResponse: {exc}"
            )

    def require_implemented(
        self, response: plugin_pb2.CodeGeneratorResponse
    ) -> plugin_pb2.CodeGeneratorResponse:
        if response.error:
            self.fail(f"generator seam is still a stub: {response.error}")
        return response

    def test_request_pins_target_dependencies_parameter_and_golden_syntax(self) -> None:
        request = self.request()
        self.assertEqual(list(request.file_to_generate), ["acme/echo.proto"])
        self.assertEqual(
            [file.name for file in request.proto_file],
            ["acme/common.proto", "acme/echo.proto"],
        )
        self.assertEqual(list(request.proto_file[1].dependency), ["acme/common.proto"])
        self.assertEqual(request.parameter, "")
        self.assertEqual(request.proto_file[1].options.SerializeToString(), b"")
        compile((GOLDEN / "echo_srpc.py").read_text(), "echo_srpc.py", "exec")
        compile((GOLDEN / "echo_srpc.pyi").read_text(), "echo_srpc.pyi", "exec")

    def test_pure_generate_is_deterministic(self) -> None:
        request = self.request()
        first = generate(request).SerializeToString(deterministic=True)
        second = generate(request).SerializeToString(deterministic=True)
        self.assertEqual(first, second)
        response = plugin_pb2.CodeGeneratorResponse.FromString(first)
        self.assertEqual(
            [file.name for file in response.file],
            ["acme/echo_srpc.py", "acme/echo_srpc.pyi"],
        )

    def test_four_shape_service_only_golden_handshake(self) -> None:
        response = self.require_implemented(self.run_plugin(self.request()))
        self.assertEqual(response.supported_features, 1)
        self.assertEqual(
            [file.name for file in response.file],
            ["acme/echo_srpc.py", "acme/echo_srpc.pyi"],
        )
        self.assertFalse(
            any(file.name.endswith(("_pb2.py", "_pb2.pyi")) for file in response.file)
        )
        expected = [
            (GOLDEN / "echo_srpc.py").read_text(),
            (GOLDEN / "echo_srpc.pyi").read_text(),
        ]
        self.assertEqual([file.content for file in response.file], expected)
        source, stub = expected
        self.assertEqual(source.count("class EchoServer"), 1)
        self.assertEqual(source.count("def register_echo"), 1)
        self.assertEqual(source.count("await call.finish()"), 1)
        self.assertNotIn("        await call.finish()\n        try:", source)
        self.assertNotIn("extra = await call.receive()", source)
        self.assertIn("while True:", source)
        self.assertIn("requests: AsyncIterable[_acme_common_pb2.Shared]", source)
        self.assertIn("requests: AsyncIterator[_acme_common_pb2.Shared]", stub)

    def test_uninterpreted_method_option_is_preserved_and_not_interpreted(self) -> None:
        request = self.request()
        option = (
            request.proto_file[-1]
            .service[0]
            .method[0]
            .options.uninterpreted_option.add()
        )
        option.name.add(
            name_part="compatibility.compatibility_method", is_extension=True
        )
        option.string_value = b"compatibility-v1"
        before = request.proto_file[-1].service[0].method[0].options.SerializeToString()
        response = generate(request)
        after = request.proto_file[-1].service[0].method[0].options.SerializeToString()
        self.assertEqual(after, before)
        self.assertEqual(response.error, "")
        self.assertEqual(
            [file.name for file in response.file],
            ["acme/echo_srpc.py", "acme/echo_srpc.pyi"],
        )
        self.assertNotIn("compatibility_method", response.file[0].content)
        self.assertNotIn("compatibility_method", response.file[1].content)
        self.assertIn('"acme.Echo"', response.file[0].content)
        self.assertIn('"Unary"', response.file[0].content)

    def test_interpreted_option_request_is_rejected_exactly(self) -> None:
        request = self.request(
            parameter="interpret_options=compatibility.compatibility_method"
        )
        response = generate(request)
        self.assertEqual(
            response.error,
            "unsupported parameter: interpret_options=compatibility.compatibility_method",
        )

    def test_multiple_services_share_one_output_pair(self) -> None:
        request = self.request()
        request.proto_file[-1].service.add(name="Aux")
        response = generate(request)
        self.assertEqual(
            [file.name for file in response.file],
            ["acme/echo_srpc.py", "acme/echo_srpc.pyi"],
        )
        self.assertEqual(response.file[0].content.count("class AuxServer"), 1)
        self.assertEqual(response.file[0].content.count("def register_aux"), 1)

    def test_single_method_metadata_uses_a_tuple(self) -> None:
        request = self.request()
        del request.proto_file[-1].service[0].method[1:]
        response = generate(request)
        tree = ast.parse(response.file[0].content)
        assignment = next(
            node
            for node in tree.body
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "ServiceDescriptor"
        )
        self.assertIsInstance(assignment.value, ast.Call)
        assert isinstance(assignment.value, ast.Call)
        self.assertIsInstance(assignment.value.args[1], ast.Tuple)

    def test_malformed_request_returns_protocol_error(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "starpc_plugin"],
            input=b"\xff",
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        response = plugin_pb2.CodeGeneratorResponse.FromString(proc.stdout)
        self.assertTrue(response.error.startswith("invalid request:"), response.error)

    def test_parameter_is_empty_and_errors_are_deterministic(self) -> None:
        response = self.run_plugin(self.request(parameter="unsupported=1"))
        self.assertEqual(response.error, "unsupported parameter: unsupported=1")
        missing = self.run_plugin(self.request(target="acme/missing.proto"))
        self.assertEqual(missing.error, "descriptor not found: acme/missing.proto")

    def test_root_proto_and_nested_message_types_use_python_module_shape(self) -> None:
        request = self.request(target="echo.proto")
        target = request.proto_file[-1]
        target.name = "echo.proto"
        del target.message_type[:]
        outer = target.message_type.add(name="Outer")
        outer.nested_type.add(name="Request")
        outer.nested_type.add(name="Response")
        del target.service[0].method[1:]
        method = target.service[0].method[0]
        method.input_type = ".acme.Outer.Request"
        method.output_type = ".acme.Outer.Response"

        response = self.require_implemented(self.run_plugin(request))
        self.assertEqual(
            [file.name for file in response.file],
            ["echo_srpc.py", "echo_srpc.pyi"],
        )
        for file in response.file:
            self.assertIn("import echo_pb2 as _echo_pb2", file.content)
            self.assertIn("_echo_pb2.Outer.Request", file.content)
            self.assertIn("_echo_pb2.Outer.Response", file.content)
            compile(file.content, file.name, "exec")

    def test_missing_message_type_is_rejected(self) -> None:
        request = self.request()
        request.proto_file[-1].service[0].method[0].input_type = ".acme.Missing"
        response = self.run_plugin(request)
        self.assertEqual(response.error, "message type not found: acme.Missing")


if __name__ == "__main__":
    unittest.main()
