// @generated by protoc-gen-es-lite unknown with parameter "target=ts,ts_nocheck=false"
// @generated from file github.com/aperturerobotics/starpc/echo/echo.proto (package echo, syntax proto3)
/* eslint-disable */

import type { MessageType, PartialFieldInfo } from "@aptre/protobuf-es-lite";
import { createMessageType, Message } from "@aptre/protobuf-es-lite";

export const protobufPackage = "echo";

/**
 * EchoMsg is the message body for Echo.
 *
 * @generated from message echo.EchoMsg
 */
export type EchoMsg = Message<{
  /**
   * @generated from field: string body = 1;
   */
  body?: string;

}>;

export const EchoMsg: MessageType<EchoMsg> = createMessageType(
  {
    typeName: "echo.EchoMsg",
    fields: [
        { no: 1, name: "body", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

