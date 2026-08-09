from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import PurePosixPath
from typing import Any

from google.protobuf.compiler import plugin_pb2
from google.protobuf.descriptor_pb2 import FileDescriptorProto

FEATURE_PROTO3_OPTIONAL = 1


def _message_index(files: Iterable[FileDescriptorProto]) -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}

    def visit(
        file: FileDescriptorProto,
        proto_prefix: str,
        python_prefix: str,
        messages: Iterable[Any],
    ) -> None:
        for message in messages:
            proto_name = (
                f"{proto_prefix}.{message.name}" if proto_prefix else message.name
            )
            python_name = (
                f"{python_prefix}.{message.name}" if python_prefix else message.name
            )
            result[f".{proto_name}"] = (file.name, python_name)
            visit(file, proto_name, python_name, message.nested_type)

    for file in files:
        visit(file, file.package, "", file.message_type)
    return result


def _module(name: str) -> str:
    path = PurePosixPath(name)
    return ".".join((*path.parts[:-1], path.stem + "_pb2"))


def _alias(module: str) -> str:
    return "_" + re.sub(r"\W", "_", module.replace(".", "_"))


def _snake(name: str) -> str:
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()


def _stem(name: str) -> str:
    path = PurePosixPath(name)
    return str(path.with_name(path.stem + "_srpc.py"))


def _expr(
    type_name: str, index: dict[str, tuple[str, str]], aliases: dict[str, str]
) -> str:
    file_name, python_name = index[type_name]
    return f"{aliases[_module(file_name)]}.{python_name}"


def _import(module: str, alias: str) -> str:
    package, separator, name = module.rpartition(".")
    if not separator:
        return f"import {name} as {alias}"
    return f"from {package} import {name} as {alias}"


def _imports(
    services: Iterable[Any], index: dict[str, tuple[str, str]]
) -> tuple[str, dict[str, str]]:
    modules: set[str] = set()
    for service in services:
        for method in service.method:
            modules.add(_module(index[method.input_type][0]))
            modules.add(_module(index[method.output_type][0]))
    aliases = {module: _alias(module) for module in sorted(modules)}
    lines = [_import(module, alias) for module, alias in aliases.items()]
    return "\n".join(lines), aliases


def _format_source(source: str, suffix: str = ".py") -> str:
    filename = "generated" + suffix
    checked = subprocess.run(
        [
            sys.executable,
            "-m",
            "ruff",
            "check",
            "--fix",
            "--stdin-filename",
            filename,
            "-",
        ],
        input=source,
        text=True,
        capture_output=True,
        check=True,
    )
    formatted = subprocess.run(
        [
            sys.executable,
            "-m",
            "ruff",
            "format",
            "--stdin-filename",
            filename,
            "-",
        ],
        input=checked.stdout,
        text=True,
        capture_output=True,
        check=True,
    )
    return formatted.stdout


def _service_source(
    file: FileDescriptorProto,
    services: Sequence[Any],
    index: dict[str, tuple[str, str]],
) -> str:
    imports, aliases = _imports(services, index)
    lines = [
        "from __future__ import annotations",
        "",
        "from collections.abc import AsyncIterable, AsyncIterator",
        "from typing import Protocol",
        "",
        imports,
        "from starpc.call import Call, CallProtocolError",
        "from starpc.client import Client",
        "from starpc.server import ServiceRegistry",
        "from starpc.service import MethodDescriptor, ServiceDescriptor, bidirectional_bytes",
        "",
    ]
    for service in services:
        canonical = f"{file.package}.{service.name}" if file.package else service.name
        methods = "\n".join(
            f"        MethodDescriptor({m.name!r}, {_expr(m.input_type, index, aliases)}, {_expr(m.output_type, index, aliases)}, {m.client_streaming!r}, {m.server_streaming!r}),"
            for m in service.method
        )
        lines += [
            f"{service.name.upper()}_SERVICE = ServiceDescriptor({canonical!r}, (",
            methods,
            "    ))",
            "",
        ]
    for service in services:
        canonical = f"{file.package}.{service.name}" if file.package else service.name
        lines += [
            f"class {service.name}Client:",
            "    def __init__(self, client: Client, service: str | None = None) -> None:",
            "        self._client = client",
            f"        self._service = service or {canonical!r}",
            "",
        ]
        for method in service.method:
            n, i, o = (
                _snake(method.name),
                _expr(method.input_type, index, aliases),
                _expr(method.output_type, index, aliases),
            )
            if not method.client_streaming and not method.server_streaming:
                lines += [
                    f"    async def {n}(self, request: {i}) -> {o}:",
                    f"        call = await self._client.open_call(self._service, {method.name!r}, request.SerializeToString(deterministic=True))",
                    "        try:",
                    "            data = await call.receive()",
                    "            if data is None:",
                    "                raise CallProtocolError('missing unary response')",
                    f"            response = {o}()",
                    "            response.ParseFromString(data)",
                    "            if await call.receive() is not None:",
                    "                raise CallProtocolError('extra unary response')",
                    "            return response",
                    "        finally:",
                    "            await call.aclose()",
                    "",
                ]
            elif method.server_streaming and not method.client_streaming:
                lines += [
                    f"    async def {n}(self, request: {i}) -> AsyncIterator[{o}]:",
                    f"        call = await self._client.open_call(self._service, {method.name!r}, request.SerializeToString(deterministic=True))",
                    "        try:",
                    "            while True:",
                    "                data = await call.receive()",
                    "                if data is None:",
                    "                    return",
                    f"                response = {o}()",
                    "                response.ParseFromString(data)",
                    "                yield response",
                    "        finally:",
                    "            await call.aclose()",
                    "",
                ]
            elif method.client_streaming and not method.server_streaming:
                lines += [
                    f"    async def {n}(self, requests: AsyncIterable[{i}]) -> {o}:",
                    f"        call = await self._client.open_call(self._service, {method.name!r})",
                    "        try:",
                    "            async for request in requests:",
                    "                await call.send(request.SerializeToString(deterministic=True))",
                    "            await call.finish()",
                    "            data = await call.receive()",
                    "            if data is None:",
                    "                raise CallProtocolError('missing client-stream response')",
                    f"            response = {o}()",
                    "            response.ParseFromString(data)",
                    "            if await call.receive() is not None:",
                    "                raise CallProtocolError('extra client-stream response')",
                    "            return response",
                    "        finally:",
                    "            await call.aclose()",
                    "",
                ]
            else:
                lines += [
                    f"    async def {n}(self, requests: AsyncIterable[{i}]) -> AsyncIterator[{o}]:",
                    f"        call = await self._client.open_call(self._service, {method.name!r})",
                    "        async def encoded() -> AsyncIterator[bytes]:",
                    "            async for request in requests:",
                    "                yield request.SerializeToString(deterministic=True)",
                    "        async for data in bidirectional_bytes(call, encoded()):",
                    f"            response = {o}()",
                    "            response.ParseFromString(data)",
                    "            yield response",
                    "",
                ]
    lines += _server_sources(file, services, index, aliases)
    return _format_source("\n".join(lines).rstrip() + "\n")


def _server_sources(
    file: FileDescriptorProto,
    services: Sequence[Any],
    index: dict[str, tuple[str, str]],
    aliases: dict[str, str],
) -> list[str]:
    lines: list[str] = []
    for service in services:
        lines.append(f"class {service.name}Server(Protocol):")
        if not service.method:
            lines.append("    pass")
        for method in service.method:
            n, i, o = (
                _snake(method.name),
                _expr(method.input_type, index, aliases),
                _expr(method.output_type, index, aliases),
            )
            if not method.client_streaming and not method.server_streaming:
                sig = f"async def {n}(self, request: {i}) -> {o}: ..."
            elif method.server_streaming and not method.client_streaming:
                sig = f"def {n}(self, request: {i}) -> AsyncIterator[{o}]: ..."
            elif method.client_streaming and not method.server_streaming:
                sig = f"async def {n}(self, requests: AsyncIterator[{i}]) -> {o}: ..."
            else:
                sig = f"def {n}(self, requests: AsyncIterator[{i}]) -> AsyncIterator[{o}]: ..."
            lines.append(f"    {sig}")
        lines.append("")
        canonical = f"{file.package}.{service.name}" if file.package else service.name
        lines.append(
            f"def register_{_snake(service.name)}(registry: ServiceRegistry, implementation: {service.name}Server, service: str = {canonical!r}) -> None:"
        )
        if not service.method:
            lines.append("    pass")
        for method in service.method:
            n, i, o = (
                _snake(method.name),
                _expr(method.input_type, index, aliases),
                _expr(method.output_type, index, aliases),
            )
            lines.append(f"    async def {n}_handler(call: Call) -> None:")
            if not method.client_streaming:
                lines += [
                    "        first = await call.receive()",
                    "        if first is None:",
                    "            raise CallProtocolError('missing initial request')",
                    f"        request = {i}()",
                    "        request.ParseFromString(first)",
                ]
                if method.server_streaming:
                    lines += [
                        f"        async for response in implementation.{n}(request):",
                        "            await call.send(response.SerializeToString(deterministic=True))",
                    ]
                else:
                    lines += [
                        f"        response = await implementation.{n}(request)",
                        "        await call.send(response.SerializeToString(deterministic=True))",
                    ]
            else:
                lines += [
                    f"        async def requests() -> AsyncIterator[{i}]:",
                    "            while True:",
                    "                data = await call.receive()",
                    "                if data is None:",
                    "                    return",
                    f"                request = {i}()",
                    "                request.ParseFromString(data)",
                    "                yield request",
                ]
                if method.server_streaming:
                    lines += [
                        f"        async for response in implementation.{n}(requests()):",
                        "            await call.send(response.SerializeToString(deterministic=True))",
                    ]
                else:
                    lines += [
                        f"        response = await implementation.{n}(requests())",
                        "        await call.send(response.SerializeToString(deterministic=True))",
                    ]
            lines.append(
                f"    registry.register(service, {method.name!r}, {n}_handler)"
            )
        lines.append("")
    return lines


def _pyi_source(
    file: FileDescriptorProto,
    services: Sequence[Any],
    index: dict[str, tuple[str, str]],
) -> str:
    imports, aliases = _imports(services, index)
    lines = [
        "",
        "from collections.abc import AsyncIterable, AsyncIterator",
        "from typing import Protocol",
        "",
        imports,
        "from starpc.client import Client",
        "from starpc.server import ServiceRegistry",
        "from starpc.service import ServiceDescriptor",
        "",
    ]
    for service in services:
        canonical = f"{file.package}.{service.name}" if file.package else service.name
        lines += [
            f"{service.name.upper()}_SERVICE: ServiceDescriptor",
            f"class {service.name}Client:",
            "    def __init__(self, client: Client, service: str | None = None) -> None: ...",
            "",
        ]
        for method in service.method:
            n, i, o = (
                _snake(method.name),
                _expr(method.input_type, index, aliases),
                _expr(method.output_type, index, aliases),
            )
            if not method.client_streaming and not method.server_streaming:
                sig = f"    async def {n}(self, request: {i}) -> {o}: ..."
            elif method.server_streaming and not method.client_streaming:
                sig = f"    def {n}(self, request: {i}) -> AsyncIterator[{o}]: ..."
            elif method.client_streaming and not method.server_streaming:
                sig = (
                    f"    async def {n}(self, requests: AsyncIterable[{i}]) -> {o}: ..."
                )
            else:
                sig = f"    def {n}(self, requests: AsyncIterable[{i}]) -> AsyncIterator[{o}]: ..."
            lines.append(sig)
        lines += ["", f"class {service.name}Server(Protocol):"]
        if not service.method:
            lines.append("    pass")
        for method in service.method:
            n, i, o = (
                _snake(method.name),
                _expr(method.input_type, index, aliases),
                _expr(method.output_type, index, aliases),
            )
            if not method.client_streaming and not method.server_streaming:
                sig = f"    async def {n}(self, request: {i}) -> {o}: ..."
            elif method.server_streaming and not method.client_streaming:
                sig = f"    def {n}(self, request: {i}) -> AsyncIterator[{o}]: ..."
            elif method.client_streaming and not method.server_streaming:
                sig = (
                    f"    async def {n}(self, requests: AsyncIterator[{i}]) -> {o}: ..."
                )
            else:
                sig = f"    def {n}(self, requests: AsyncIterator[{i}]) -> AsyncIterator[{o}]: ..."
            lines.append(sig)
        lines += [
            "",
            f"def register_{_snake(service.name)}(registry: ServiceRegistry, implementation: {service.name}Server, service: str = {canonical!r}) -> None: ...",
            "",
        ]
    return _format_source("\n".join(lines).rstrip() + "\n", ".pyi")


def generate(
    request: plugin_pb2.CodeGeneratorRequest,
) -> plugin_pb2.CodeGeneratorResponse:
    if request.parameter:
        return plugin_pb2.CodeGeneratorResponse(
            error=f"unsupported parameter: {request.parameter}"
        )
    files = {file.name: file for file in request.proto_file}
    index = _message_index(request.proto_file)
    response = plugin_pb2.CodeGeneratorResponse(
        supported_features=FEATURE_PROTO3_OPTIONAL
    )
    for name in request.file_to_generate:
        file = files.get(name)
        if file is None:
            return plugin_pb2.CodeGeneratorResponse(
                error=f"descriptor not found: {name}"
            )
        services = list(file.service)
        for service in services:
            for method in service.method:
                if method.input_type not in index:
                    return plugin_pb2.CodeGeneratorResponse(
                        error=f"message type not found: {method.input_type.lstrip('.')}"
                    )
                if method.output_type not in index:
                    return plugin_pb2.CodeGeneratorResponse(
                        error=f"message type not found: {method.output_type.lstrip('.')}"
                    )
        if services:
            response.file.add(
                name=_stem(name), content=_service_source(file, services, index)
            )
            response.file.add(
                name=_stem(name).replace(".py", ".pyi"),
                content=_pyi_source(file, services, index),
            )
    return response
