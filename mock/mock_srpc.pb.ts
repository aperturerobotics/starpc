// @generated by protoc-gen-es-starpc none with parameter "target=ts,ts_nocheck=false"
// @generated from file github.com/aperturerobotics/starpc/mock/mock.proto (package e2e.mock, syntax proto3)
/* eslint-disable */

import { MockMsg } from "./mock.pb.js";
import { MethodKind } from "@aptre/protobuf-es-lite";
import { ProtoRpc } from "starpc";

/**
 * Mock service mocks some RPCs for the e2e tests.
 *
 * @generated from service e2e.mock.Mock
 */
export const MockDefinition = {
  typeName: "e2e.mock.Mock",
  methods: {
    /**
     * MockRequest runs a mock unary request.
     *
     * @generated from rpc e2e.mock.Mock.MockRequest
     */
    MockRequest: {
      name: "MockRequest",
      I: MockMsg,
      O: MockMsg,
      kind: MethodKind.Unary,
    },
  }
} as const;

/**
 * Mock service mocks some RPCs for the e2e tests.
 *
 * @generated from service e2e.mock.Mock
 */
export interface Mock {
  /**
   * MockRequest runs a mock unary request.
   *
   * @generated from rpc e2e.mock.Mock.MockRequest
   */
  MockRequest(
request: MockMsg, abortSignal?: AbortSignal
): 
Promise<MockMsg>

}

export const MockServiceName = MockDefinition.typeName

export class MockClient implements Mock {
  private readonly rpc: ProtoRpc
  private readonly service: string
  constructor(rpc: ProtoRpc, opts?: { service?: string }) {
    this.service = opts?.service || MockServiceName
    this.rpc = rpc
    this.MockRequest = this.MockRequest.bind(this)
  }
  /**
   * MockRequest runs a mock unary request.
   *
   * @generated from rpc e2e.mock.Mock.MockRequest
   */
  async MockRequest(
request: MockMsg, abortSignal?: AbortSignal
): 
Promise<MockMsg> {
    const requestMsg = MockMsg.create(request)
    const result = await this.rpc.request(
      this.service,
      MockDefinition.methods.MockRequest.name,
      MockMsg.toBinary(requestMsg),
      abortSignal || undefined,
    )
    return MockMsg.fromBinary(result)
  }

}
