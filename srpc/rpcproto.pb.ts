/* eslint-disable */
import Long from 'long'
import * as _m0 from 'protobufjs/minimal'
import {
  CallStart as CallStart1,
  CallData as CallData2,
} from './rpcproto.pb.js'

export const protobufPackage = 'srpc'

/** Packet is a message sent over a srpc packet connection. */
export interface Packet {
  body?:
    | { $case: 'callStart'; callStart: CallStart1 }
    | { $case: 'callData'; callData: CallData2 }
}

/** CallStart requests starting a new RPC call. */
export interface CallStart {
  /**
   * RpcService is the service to contact.
   * Must be set.
   */
  rpcService: string
  /**
   * RpcMethod is the RPC method to call.
   * Must be set.
   */
  rpcMethod: string
  /**
   * Data contains the request or the first message in the stream.
   * Optional if streaming.
   */
  data: Uint8Array
  /** DataIsZero indicates Data is set with an empty message. */
  dataIsZero: boolean
}

/** CallData contains a message in a streaming RPC sequence. */
export interface CallData {
  /** Data contains the packet in the sequence. */
  data: Uint8Array
  /** DataIsZero indicates Data is set with an empty message. */
  dataIsZero: boolean
  /** Complete indicates the RPC call is completed. */
  complete: boolean
  /**
   * Error contains any error that caused the RPC to fail.
   * If set, implies complete=true.
   */
  error: string
}

function createBasePacket(): Packet {
  return { body: undefined }
}

export const Packet = {
  encode(
    message: Packet,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.body?.$case === 'callStart') {
      CallStart1.encode(
        message.body.callStart,
        writer.uint32(10).fork()
      ).ldelim()
    }
    if (message.body?.$case === 'callData') {
      CallData2.encode(message.body.callData, writer.uint32(18).fork()).ldelim()
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Packet {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBasePacket()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.body = {
            $case: 'callStart',
            callStart: CallStart1.decode(reader, reader.uint32()),
          }
          break
        case 2:
          message.body = {
            $case: 'callData',
            callData: CallData2.decode(reader, reader.uint32()),
          }
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  // encodeTransform encodes a source of message objects.
  // Transform<Packet, Uint8Array>
  async *encodeTransform(
    source: AsyncIterable<Packet | Packet[]> | Iterable<Packet | Packet[]>
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [Packet.encode(p).finish()]
        }
      } else {
        yield* [Packet.encode(pkt).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, Packet>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>
  ): AsyncIterable<Packet> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [Packet.decode(p)]
        }
      } else {
        yield* [Packet.decode(pkt)]
      }
    }
  },

  fromJSON(object: any): Packet {
    return {
      body: isSet(object.callStart)
        ? {
            $case: 'callStart',
            callStart: CallStart1.fromJSON(object.callStart),
          }
        : isSet(object.callData)
        ? { $case: 'callData', callData: CallData2.fromJSON(object.callData) }
        : undefined,
    }
  },

  toJSON(message: Packet): unknown {
    const obj: any = {}
    message.body?.$case === 'callStart' &&
      (obj.callStart = message.body?.callStart
        ? CallStart1.toJSON(message.body?.callStart)
        : undefined)
    message.body?.$case === 'callData' &&
      (obj.callData = message.body?.callData
        ? CallData2.toJSON(message.body?.callData)
        : undefined)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<Packet>, I>>(object: I): Packet {
    const message = createBasePacket()
    if (
      object.body?.$case === 'callStart' &&
      object.body?.callStart !== undefined &&
      object.body?.callStart !== null
    ) {
      message.body = {
        $case: 'callStart',
        callStart: CallStart1.fromPartial(object.body.callStart),
      }
    }
    if (
      object.body?.$case === 'callData' &&
      object.body?.callData !== undefined &&
      object.body?.callData !== null
    ) {
      message.body = {
        $case: 'callData',
        callData: CallData2.fromPartial(object.body.callData),
      }
    }
    return message
  },
}

function createBaseCallStart(): CallStart {
  return {
    rpcService: '',
    rpcMethod: '',
    data: new Uint8Array(),
    dataIsZero: false,
  }
}

export const CallStart = {
  encode(
    message: CallStart,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.rpcService !== '') {
      writer.uint32(10).string(message.rpcService)
    }
    if (message.rpcMethod !== '') {
      writer.uint32(18).string(message.rpcMethod)
    }
    if (message.data.length !== 0) {
      writer.uint32(26).bytes(message.data)
    }
    if (message.dataIsZero === true) {
      writer.uint32(32).bool(message.dataIsZero)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): CallStart {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseCallStart()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.rpcService = reader.string()
          break
        case 2:
          message.rpcMethod = reader.string()
          break
        case 3:
          message.data = reader.bytes()
          break
        case 4:
          message.dataIsZero = reader.bool()
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  // encodeTransform encodes a source of message objects.
  // Transform<CallStart, Uint8Array>
  async *encodeTransform(
    source:
      | AsyncIterable<CallStart | CallStart[]>
      | Iterable<CallStart | CallStart[]>
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [CallStart.encode(p).finish()]
        }
      } else {
        yield* [CallStart.encode(pkt).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, CallStart>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>
  ): AsyncIterable<CallStart> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [CallStart.decode(p)]
        }
      } else {
        yield* [CallStart.decode(pkt)]
      }
    }
  },

  fromJSON(object: any): CallStart {
    return {
      rpcService: isSet(object.rpcService) ? String(object.rpcService) : '',
      rpcMethod: isSet(object.rpcMethod) ? String(object.rpcMethod) : '',
      data: isSet(object.data)
        ? bytesFromBase64(object.data)
        : new Uint8Array(),
      dataIsZero: isSet(object.dataIsZero) ? Boolean(object.dataIsZero) : false,
    }
  },

  toJSON(message: CallStart): unknown {
    const obj: any = {}
    message.rpcService !== undefined && (obj.rpcService = message.rpcService)
    message.rpcMethod !== undefined && (obj.rpcMethod = message.rpcMethod)
    message.data !== undefined &&
      (obj.data = base64FromBytes(
        message.data !== undefined ? message.data : new Uint8Array()
      ))
    message.dataIsZero !== undefined && (obj.dataIsZero = message.dataIsZero)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<CallStart>, I>>(
    object: I
  ): CallStart {
    const message = createBaseCallStart()
    message.rpcService = object.rpcService ?? ''
    message.rpcMethod = object.rpcMethod ?? ''
    message.data = object.data ?? new Uint8Array()
    message.dataIsZero = object.dataIsZero ?? false
    return message
  },
}

function createBaseCallData(): CallData {
  return {
    data: new Uint8Array(),
    dataIsZero: false,
    complete: false,
    error: '',
  }
}

export const CallData = {
  encode(
    message: CallData,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.data.length !== 0) {
      writer.uint32(10).bytes(message.data)
    }
    if (message.dataIsZero === true) {
      writer.uint32(16).bool(message.dataIsZero)
    }
    if (message.complete === true) {
      writer.uint32(24).bool(message.complete)
    }
    if (message.error !== '') {
      writer.uint32(34).string(message.error)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): CallData {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseCallData()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.data = reader.bytes()
          break
        case 2:
          message.dataIsZero = reader.bool()
          break
        case 3:
          message.complete = reader.bool()
          break
        case 4:
          message.error = reader.string()
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  // encodeTransform encodes a source of message objects.
  // Transform<CallData, Uint8Array>
  async *encodeTransform(
    source:
      | AsyncIterable<CallData | CallData[]>
      | Iterable<CallData | CallData[]>
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [CallData.encode(p).finish()]
        }
      } else {
        yield* [CallData.encode(pkt).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, CallData>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>
  ): AsyncIterable<CallData> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [CallData.decode(p)]
        }
      } else {
        yield* [CallData.decode(pkt)]
      }
    }
  },

  fromJSON(object: any): CallData {
    return {
      data: isSet(object.data)
        ? bytesFromBase64(object.data)
        : new Uint8Array(),
      dataIsZero: isSet(object.dataIsZero) ? Boolean(object.dataIsZero) : false,
      complete: isSet(object.complete) ? Boolean(object.complete) : false,
      error: isSet(object.error) ? String(object.error) : '',
    }
  },

  toJSON(message: CallData): unknown {
    const obj: any = {}
    message.data !== undefined &&
      (obj.data = base64FromBytes(
        message.data !== undefined ? message.data : new Uint8Array()
      ))
    message.dataIsZero !== undefined && (obj.dataIsZero = message.dataIsZero)
    message.complete !== undefined && (obj.complete = message.complete)
    message.error !== undefined && (obj.error = message.error)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<CallData>, I>>(object: I): CallData {
    const message = createBaseCallData()
    message.data = object.data ?? new Uint8Array()
    message.dataIsZero = object.dataIsZero ?? false
    message.complete = object.complete ?? false
    message.error = object.error ?? ''
    return message
  },
}

declare var self: any | undefined
declare var window: any | undefined
declare var global: any | undefined
var globalThis: any = (() => {
  if (typeof globalThis !== 'undefined') return globalThis
  if (typeof self !== 'undefined') return self
  if (typeof window !== 'undefined') return window
  if (typeof global !== 'undefined') return global
  throw 'Unable to locate global object'
})()

const atob: (b64: string) => string =
  globalThis.atob ||
  ((b64) => globalThis.Buffer.from(b64, 'base64').toString('binary'))
function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; ++i) {
    arr[i] = bin.charCodeAt(i)
  }
  return arr
}

const btoa: (bin: string) => string =
  globalThis.btoa ||
  ((bin) => globalThis.Buffer.from(bin, 'binary').toString('base64'))
function base64FromBytes(arr: Uint8Array): string {
  const bin: string[] = []
  arr.forEach((byte) => {
    bin.push(String.fromCharCode(byte))
  })
  return btoa(bin.join(''))
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
