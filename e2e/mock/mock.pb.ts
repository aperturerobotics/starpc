/* eslint-disable */
import Long from 'long'
import _m0 from 'protobufjs/minimal.js'

export const protobufPackage = 'e2e.mock'

/** MockMsg is the mock message body. */
export interface MockMsg {
  body: string
}

function createBaseMockMsg(): MockMsg {
  return { body: '' }
}

export const MockMsg = {
  encode(
    message: MockMsg,
    writer: _m0.Writer = _m0.Writer.create(),
  ): _m0.Writer {
    if (message.body !== '') {
      writer.uint32(10).string(message.body)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): MockMsg {
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseMockMsg()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break
          }

          message.body = reader.string()
          continue
      }
      if ((tag & 7) === 4 || tag === 0) {
        break
      }
      reader.skipType(tag & 7)
    }
    return message
  },

  // encodeTransform encodes a source of message objects.
  // Transform<MockMsg, Uint8Array>
  async *encodeTransform(
    source: AsyncIterable<MockMsg | MockMsg[]> | Iterable<MockMsg | MockMsg[]>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [MockMsg.encode(p).finish()]
        }
      } else {
        yield* [MockMsg.encode(pkt as any).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, MockMsg>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>,
  ): AsyncIterable<MockMsg> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [MockMsg.decode(p)]
        }
      } else {
        yield* [MockMsg.decode(pkt as any)]
      }
    }
  },

  fromJSON(object: any): MockMsg {
    return { body: isSet(object.body) ? globalThis.String(object.body) : '' }
  },

  toJSON(message: MockMsg): unknown {
    const obj: any = {}
    if (message.body !== '') {
      obj.body = message.body
    }
    return obj
  },

  create<I extends Exact<DeepPartial<MockMsg>, I>>(base?: I): MockMsg {
    return MockMsg.fromPartial(base ?? ({} as any))
  },
  fromPartial<I extends Exact<DeepPartial<MockMsg>, I>>(object: I): MockMsg {
    const message = createBaseMockMsg()
    message.body = object.body ?? ''
    return message
  },
}

/** Mock service mocks some RPCs for the e2e tests. */
export interface Mock {
  /** MockRequest runs a mock unary request. */
  MockRequest(request: MockMsg, abortSignal?: AbortSignal): Promise<MockMsg>
}

export const MockServiceName = 'e2e.mock.Mock'
export class MockClientImpl implements Mock {
  private readonly rpc: Rpc
  private readonly service: string
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || MockServiceName
    this.rpc = rpc
    this.MockRequest = this.MockRequest.bind(this)
  }
  MockRequest(request: MockMsg, abortSignal?: AbortSignal): Promise<MockMsg> {
    const data = MockMsg.encode(request).finish()
    const promise = this.rpc.request(
      this.service,
      'MockRequest',
      data,
      abortSignal || undefined,
    )
    return promise.then((data) => MockMsg.decode(_m0.Reader.create(data)))
  }
}

/** Mock service mocks some RPCs for the e2e tests. */
export type MockDefinition = typeof MockDefinition
export const MockDefinition = {
  name: 'Mock',
  fullName: 'e2e.mock.Mock',
  methods: {
    /** MockRequest runs a mock unary request. */
    mockRequest: {
      name: 'MockRequest',
      requestType: MockMsg,
      requestStream: false,
      responseType: MockMsg,
      responseStream: false,
      options: {},
    },
  },
} as const

interface Rpc {
  request(
    service: string,
    method: string,
    data: Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Uint8Array>
}

type Builtin =
  | Date
  | Function
  | Uint8Array
  | string
  | number
  | boolean
  | undefined

export type DeepPartial<T> = T extends Builtin
  ? T
  : T extends Long
    ? string | number | Long
    : T extends globalThis.Array<infer U>
      ? globalThis.Array<DeepPartial<U>>
      : T extends ReadonlyArray<infer U>
        ? ReadonlyArray<DeepPartial<U>>
        : T extends { $case: string }
          ? { [K in keyof Omit<T, '$case'>]?: DeepPartial<T[K]> } & {
              $case: T['$case']
            }
          : T extends {}
            ? { [K in keyof T]?: DeepPartial<T[K]> }
            : Partial<T>

type KeysOfUnion<T> = T extends T ? keyof T : never
export type Exact<P, I extends P> = P extends Builtin
  ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & {
      [K in Exclude<keyof I, KeysOfUnion<P>>]: never
    }

if (_m0.util.Long !== Long) {
  _m0.util.Long = Long as any
  _m0.configure()
}

function isSet(value: any): boolean {
  return value !== null && value !== undefined
}
