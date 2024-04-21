// @generated by protoc-gen-es-starpc v0.30.1 with parameter "target=ts"
// @generated from file github.com/aperturerobotics/starpc/e2e/mock/mock.proto (package e2e.mock, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import { MockMsg } from './mock_pb.js'
import { MethodKind } from '@bufbuild/protobuf'

/**
 * Mock service mocks some RPCs for the e2e tests.
 *
 * @generated from service e2e.mock.Mock
 */
export const Mock = {
  typeName: 'e2e.mock.Mock',
  methods: {
    /**
     * MockRequest runs a mock unary request.
     *
     * @generated from rpc e2e.mock.Mock.MockRequest
     */
    mockRequest: {
      name: 'MockRequest',
      I: MockMsg,
      O: MockMsg,
      kind: MethodKind.Unary,
    },
  },
} as const

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
  mockRequest(request: MockMsg, abortSignal?: AbortSignal): Promise<MockMsg>
}

export const MockServiceName = 'e2e.mock.Mock'

export class MockClientImpl implements Mock {
  private readonly rpc: ProtoRpc
  private readonly service: string
  constructor(rpc: ProtoRpc, opts?: { service?: string }) {
    this.service = opts?.service || MockServiceName
    this.rpc = rpc
    this.mockRequest = this.mockRequest.bind(this)
  }
  /**
   * MockRequest runs a mock unary request.
   *
   * @generated from rpc e2e.mock.Mock.MockRequest
   */
  async mockRequest(
    request: MockMsg,
    abortSignal?: AbortSignal,
  ): Promise<MockMsg> {
    const result = await this.rpc.request(
      this.service,
      Mock.methods.mockRequest.name,
      request.toBinary(),
      abortSignal || undefined,
    )
    return MockMsg.fromBinary(result)
  }
}