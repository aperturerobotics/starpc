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

import type { DescService } from "@bufbuild/protobuf";
import { MethodIdempotency, MethodKind } from "@bufbuild/protobuf";
import type { GeneratedFile, Schema } from "@bufbuild/protoplugin/ecmascript";
import { localName } from "@bufbuild/protoplugin/ecmascript";

export function generateTs(schema: Schema) {
  for (const protoFile of schema.files) {
    const file = schema.generateFile(protoFile.name + "_srpc.pb.ts");
    file.preamble(protoFile);
    for (const service of protoFile.services) {
      generateService(schema, file, service);
    }
  }
}

// prettier-ignore
function generateService(
  schema: Schema,
  f: GeneratedFile,
  service: DescService
) {
  const { MethodKind: rtMethodKind, MethodIdempotency: rtMethodIdempotency } =
    schema.runtime;

// NOTE: This matches generateService from @connectrpc/protoc-gen-connect-es.
  f.print(f.jsDoc(service));
  f.print(f.exportDecl("const", localName(service)), " = {");
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


  // NOTE: This matches the proto rpc interface from ts-proto.
}
