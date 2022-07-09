/* eslint-disable */
import Long from 'long'
import { RpcStreamPacket } from '../rpcstream/rpcstream.pb.js'
import * as _m0 from 'protobufjs/minimal'

export const protobufPackage = 'echo'

/** EchoMsg is the message body for Echo. */
export interface EchoMsg {
  body: string
}

function createBaseEchoMsg(): EchoMsg {
  return { body: '' }
}

export const EchoMsg = {
  encode(
    message: EchoMsg,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.body !== '') {
      writer.uint32(10).string(message.body)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): EchoMsg {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseEchoMsg()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.body = reader.string()
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  // encodeTransform encodes a source of message objects.
  // Transform<EchoMsg, Uint8Array>
  async *encodeTransform(
    source: AsyncIterable<EchoMsg | EchoMsg[]> | Iterable<EchoMsg | EchoMsg[]>
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [EchoMsg.encode(p).finish()]
        }
      } else {
        yield* [EchoMsg.encode(pkt).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, EchoMsg>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>
  ): AsyncIterable<EchoMsg> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [EchoMsg.decode(p)]
        }
      } else {
        yield* [EchoMsg.decode(pkt)]
      }
    }
  },

  fromJSON(object: any): EchoMsg {
    return {
      body: isSet(object.body) ? String(object.body) : '',
    }
  },

  toJSON(message: EchoMsg): unknown {
    const obj: any = {}
    message.body !== undefined && (obj.body = message.body)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<EchoMsg>, I>>(object: I): EchoMsg {
    const message = createBaseEchoMsg()
    message.body = object.body ?? ''
    return message
  },
}

/** Echoer service returns the given message. */
export interface Echoer {
  /** Echo returns the given message. */
  Echo(request: EchoMsg): Promise<EchoMsg>
  /** EchoServerStream is an example of a server -> client one-way stream. */
  EchoServerStream(request: EchoMsg): AsyncIterable<EchoMsg>
  /** EchoClientStream is an example of client->server one-way stream. */
  EchoClientStream(request: AsyncIterable<EchoMsg>): Promise<EchoMsg>
  /** EchoBidiStream is an example of a two-way stream. */
  EchoBidiStream(request: AsyncIterable<EchoMsg>): AsyncIterable<EchoMsg>
  /** RpcStream opens a nested rpc call stream. */
  RpcStream(
    request: AsyncIterable<RpcStreamPacket>
  ): AsyncIterable<RpcStreamPacket>
}

export class EchoerClientImpl implements Echoer {
  private readonly rpc: Rpc
  constructor(rpc: Rpc) {
    this.rpc = rpc
    this.Echo = this.Echo.bind(this)
    this.EchoServerStream = this.EchoServerStream.bind(this)
    this.EchoClientStream = this.EchoClientStream.bind(this)
    this.EchoBidiStream = this.EchoBidiStream.bind(this)
    this.RpcStream = this.RpcStream.bind(this)
  }
  Echo(request: EchoMsg): Promise<EchoMsg> {
    const data = EchoMsg.encode(request).finish()
    const promise = this.rpc.request('echo.Echoer', 'Echo', data)
    return promise.then((data) => EchoMsg.decode(new _m0.Reader(data)))
  }

  EchoServerStream(request: EchoMsg): AsyncIterable<EchoMsg> {
    const data = EchoMsg.encode(request).finish()
    const result = this.rpc.serverStreamingRequest(
      'echo.Echoer',
      'EchoServerStream',
      data
    )
    return EchoMsg.decodeTransform(result)
  }

  EchoClientStream(request: AsyncIterable<EchoMsg>): Promise<EchoMsg> {
    const data = EchoMsg.encodeTransform(request)
    const promise = this.rpc.clientStreamingRequest(
      'echo.Echoer',
      'EchoClientStream',
      data
    )
    return promise.then((data) => EchoMsg.decode(new _m0.Reader(data)))
  }

  EchoBidiStream(request: AsyncIterable<EchoMsg>): AsyncIterable<EchoMsg> {
    const data = EchoMsg.encodeTransform(request)
    const result = this.rpc.bidirectionalStreamingRequest(
      'echo.Echoer',
      'EchoBidiStream',
      data
    )
    return EchoMsg.decodeTransform(result)
  }

  RpcStream(
    request: AsyncIterable<RpcStreamPacket>
  ): AsyncIterable<RpcStreamPacket> {
    const data = RpcStreamPacket.encodeTransform(request)
    const result = this.rpc.bidirectionalStreamingRequest(
      'echo.Echoer',
      'RpcStream',
      data
    )
    return RpcStreamPacket.decodeTransform(result)
  }
}

/** Echoer service returns the given message. */
export type EchoerDefinition = typeof EchoerDefinition
export const EchoerDefinition = {
  name: 'Echoer',
  fullName: 'echo.Echoer',
  methods: {
    /** Echo returns the given message. */
    echo: {
      name: 'Echo',
      requestType: EchoMsg,
      requestStream: false,
      responseType: EchoMsg,
      responseStream: false,
      options: {},
    },
    /** EchoServerStream is an example of a server -> client one-way stream. */
    echoServerStream: {
      name: 'EchoServerStream',
      requestType: EchoMsg,
      requestStream: false,
      responseType: EchoMsg,
      responseStream: true,
      options: {},
    },
    /** EchoClientStream is an example of client->server one-way stream. */
    echoClientStream: {
      name: 'EchoClientStream',
      requestType: EchoMsg,
      requestStream: true,
      responseType: EchoMsg,
      responseStream: false,
      options: {},
    },
    /** EchoBidiStream is an example of a two-way stream. */
    echoBidiStream: {
      name: 'EchoBidiStream',
      requestType: EchoMsg,
      requestStream: true,
      responseType: EchoMsg,
      responseStream: true,
      options: {},
    },
    /** RpcStream opens a nested rpc call stream. */
    rpcStream: {
      name: 'RpcStream',
      requestType: RpcStreamPacket,
      requestStream: true,
      responseType: RpcStreamPacket,
      responseStream: true,
      options: {},
    },
  },
} as const

interface Rpc {
  request(
    service: string,
    method: string,
    data: Uint8Array
  ): Promise<Uint8Array>
  clientStreamingRequest(
    service: string,
    method: string,
    data: AsyncIterable<Uint8Array>
  ): Promise<Uint8Array>
  serverStreamingRequest(
    service: string,
    method: string,
    data: Uint8Array
  ): AsyncIterable<Uint8Array>
  bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: AsyncIterable<Uint8Array>
  ): AsyncIterable<Uint8Array>
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
  : T extends Array<infer U>
  ? Array<DeepPartial<U>>
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
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & Record<
        Exclude<keyof I, KeysOfUnion<P>>,
        never
      >

if (_m0.util.Long !== Long) {
  _m0.util.Long = Long as any
  _m0.configure()
}

function isSet(value: any): boolean {
  return value !== null && value !== undefined
}