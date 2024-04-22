// Copyright 2024 Aperture Robotics, LLC.
// Copyright 2021-2024 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { DescService } from '@bufbuild/protobuf'
import { MethodIdempotency, MethodKind } from '@bufbuild/protobuf'
import type { GeneratedFile, Schema } from '@bufbuild/protoplugin/ecmascript'
import { createImportSymbol, localName } from '@bufbuild/protoplugin/ecmascript'

export function generateTs(schema: Schema) {
  for (const protoFile of schema.files) {
    const file = schema.generateFile(protoFile.name + '_srpc.pb.ts')
    file.preamble(protoFile)
    for (const service of protoFile.services) {
      generateService(schema, file, service)
    }
  }
}

// prettier-ignore
function generateService(
  schema: Schema,
  f: GeneratedFile,
  service: DescService
) {
  const { MethodKind: rtMethodKind, MethodIdempotency: rtMethodIdempotency, PartialMessage } =
    schema.runtime;
// NOTE: This matches generateService from @connectrpc/protoc-gen-connect-es.
  f.print(f.jsDoc(service));
  f.print(f.exportDecl("const", localName(service)), "Definition = {");
  f.print(`  typeName: `, f.string(service.typeName), `,`);
  f.print("  methods: {");
  for (const method of service.methods) {
    f.print(f.jsDoc(method, "    "));
    f.print("    ", localName(method), ": {");
    f.print(`      name: `, f.string(method.name), `,`);
    f.print("      I: ", method.input, ",");
    f.print("      O: ", method.output, ",");
    f.print(
      "      kind: ",
      rtMethodKind,
      ".",
      MethodKind[method.methodKind],
      ","
    );
    if (method.idempotency !== undefined) {
      f.print(
        "      idempotency: ",
        rtMethodIdempotency,
        ".",
        MethodIdempotency[method.idempotency],
        ","
      );
    }
    // In case we start supporting options, we have to surface them here
    f.print("    },");
  }
  f.print("  }");
  f.print("} as const;");
  f.print();

  // Generate the service interface
  f.print(f.jsDoc(service));
  f.print("export interface ", localName(service), " {");
  for (const method of service.methods) {
    f.print(f.jsDoc(method, "  "));
    f.print("  ", localName(method), "(");
    if (method.methodKind === MethodKind.Unary) {
      f.print("request: ", PartialMessage, "<", method.input, ">, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.ServerStreaming) {
      f.print("request: ", PartialMessage, "<", method.input, ">, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.ClientStreaming) {
      f.print("request: AsyncIterable<", PartialMessage, "<", method.input, ">>, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.BiDiStreaming) {
      f.print("request: AsyncIterable<", PartialMessage, "<", method.input, ">>, abortSignal?: AbortSignal");
    }
    f.print("): ");
    if (method.methodKind === MethodKind.Unary) {
      f.print("Promise<", method.output, ">");
    } else if (method.methodKind === MethodKind.ServerStreaming) {
      f.print("AsyncIterable<", method.output, ">");
    } else if (method.methodKind === MethodKind.ClientStreaming) {
      f.print("Promise<", method.output, ">");
    } else if (method.methodKind === MethodKind.BiDiStreaming) {
      f.print("AsyncIterable<", method.output, ">");
    }
    f.print();
  }
  f.print("}");
  f.print();


  // Generate the service name constant
  f.print("export const ", localName(service), "ServiceName = ", localName(service), "Definition.typeName");
  f.print();

  // Generate the client implementation
  f.print("export class ", localName(service), "Client implements ", localName(service), " {");
  f.print("  private readonly rpc: ", createImportSymbol("ProtoRpc", "starpc"));
  f.print("  private readonly service: string");
  f.print("  constructor(rpc: ProtoRpc, opts?: { service?: string }) {");
  f.print("    this.service = opts?.service || ", localName(service), "ServiceName");
  f.print("    this.rpc = rpc");
  for (const method of service.methods) {
    f.print("    this.", localName(method), " = this.", localName(method), ".bind(this)");
  }
  f.print("  }");

  const buildDecodeMessageTransformSymbol = createImportSymbol("buildDecodeMessageTransform", "starpc")
  const buildEncodeMessageTransformSymbol = createImportSymbol("buildEncodeMessageTransform", "starpc")
  for (const method of service.methods) {
    f.print(f.jsDoc(method, "  "));
    f.print("  ", method.methodKind === MethodKind.Unary ? "async " : "", localName(method), "(");
    if (method.methodKind === MethodKind.Unary) {
      f.print("request: ", PartialMessage, "<", method.input, ">, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.ServerStreaming) {
      f.print("request: ", PartialMessage, "<", method.input, ">, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.ClientStreaming) {
      f.print("request: AsyncIterable<", PartialMessage, "<", method.input, ">>, abortSignal?: AbortSignal");
    } else if (method.methodKind === MethodKind.BiDiStreaming) {
      f.print("request: AsyncIterable<", PartialMessage, "<", method.input, ">>, abortSignal?: AbortSignal");
    }
    f.print("): ");
    if (method.methodKind === MethodKind.Unary) {
      f.print("Promise<", method.output, "> {");
      f.print("    const requestMsg = new ", method.input, "(request)");
      f.print("    const result = await this.rpc.request(");
      f.print("      this.service,");
      f.print("      ", localName(service), "Definition.methods.", localName(method), ".name,");
      f.print("      requestMsg.toBinary(),");
      f.print("      abortSignal || undefined,");
      f.print("    )");
      f.print("    return ", method.output, ".fromBinary(result)");
      f.print("  }");
    } else if (method.methodKind === MethodKind.ServerStreaming) {
      f.print("AsyncIterable<", method.output, "> {");
      f.print("    const requestMsg = new ", method.input, "(request)");
      f.print("    const result = this.rpc.serverStreamingRequest(");
      f.print("      this.service,");
      f.print("      ", localName(service), "Definition.methods.", localName(method), ".name,");
      f.print("      requestMsg.toBinary(),");
      f.print("      abortSignal || undefined,");
      f.print("    )");
      f.print("    return ", buildDecodeMessageTransformSymbol, "(", method.output, ")(result)");
      f.print("  }");
    } else if (method.methodKind === MethodKind.ClientStreaming) {
      f.print("Promise<", method.output, "> {");
      f.print("    const result = await this.rpc.clientStreamingRequest(");
      f.print("      this.service,");
      f.print("      ", localName(service), "Definition.methods.", localName(method), ".name,");
      f.print("      ", buildEncodeMessageTransformSymbol, "(request, ", method.input, "),");
      f.print("      abortSignal || undefined,");
      f.print("    )");
      f.print("    return ", method.output, ".fromBinary(result)");
      f.print("  }");
    } else if (method.methodKind === MethodKind.BiDiStreaming) {
      f.print("AsyncIterable<", method.output, "> {");
      f.print("    const result = this.rpc.bidirectionalStreamingRequest(");
      f.print("      this.service,");
      f.print("      ", localName(service), "Definition.methods.", localName(method), ".name,");
      f.print("      ", buildEncodeMessageTransformSymbol, "(request, ", method.input, "),");
      f.print("      abortSignal || undefined,");
      f.print("    )");
      f.print("    return ", buildDecodeMessageTransformSymbol, "(", method.output, ")(result)");
      f.print("  }");
    }
    f.print();
  }
  f.print("}");
}
