/* eslint-disable */
import Long from 'long'
import _m0 from 'protobufjs/minimal.js'

export const protobufPackage = 'srpc'

/** Packet is a message sent over a srpc packet connection. */
export interface Packet {
  body?:
    | { $case: 'callStart'; callStart: CallStart }
    | { $case: 'callData'; callData: CallData }
    | {
        $case: 'callCancel'
        callCancel: boolean
      }
    | undefined
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
    writer: _m0.Writer = _m0.Writer.create(),
  ): _m0.Writer {
    switch (message.body?.$case) {
      case 'callStart':
        CallStart.encode(
          message.body.callStart,
          writer.uint32(10).fork(),
        ).ldelim()
        break
      case 'callData':
        CallData.encode(
          message.body.callData,
          writer.uint32(18).fork(),
        ).ldelim()
        break
      case 'callCancel':
        writer.uint32(24).bool(message.body.callCancel)
        break
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Packet {
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBasePacket()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break
          }

          message.body = {
            $case: 'callStart',
            callStart: CallStart.decode(reader, reader.uint32()),
          }
          continue
        case 2:
          if (tag !== 18) {
            break
          }

          message.body = {
            $case: 'callData',
            callData: CallData.decode(reader, reader.uint32()),
          }
          continue
        case 3:
          if (tag !== 24) {
            break
          }

          message.body = { $case: 'callCancel', callCancel: reader.bool() }
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
  // Transform<Packet, Uint8Array>
  async *encodeTransform(
    source: AsyncIterable<Packet | Packet[]> | Iterable<Packet | Packet[]>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [Packet.encode(p).finish()]
        }
      } else {
        yield* [Packet.encode(pkt as any).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, Packet>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>,
  ): AsyncIterable<Packet> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [Packet.decode(p)]
        }
      } else {
        yield* [Packet.decode(pkt as any)]
      }
    }
  },

  fromJSON(object: any): Packet {
    return {
      body: isSet(object.callStart)
        ? {
            $case: 'callStart',
            callStart: CallStart.fromJSON(object.callStart),
          }
        : isSet(object.callData)
          ? { $case: 'callData', callData: CallData.fromJSON(object.callData) }
          : isSet(object.callCancel)
            ? {
                $case: 'callCancel',
                callCancel: globalThis.Boolean(object.callCancel),
              }
            : undefined,
    }
  },

  toJSON(message: Packet): unknown {
    const obj: any = {}
    if (message.body?.$case === 'callStart') {
      obj.callStart = CallStart.toJSON(message.body.callStart)
    }
    if (message.body?.$case === 'callData') {
      obj.callData = CallData.toJSON(message.body.callData)
    }
    if (message.body?.$case === 'callCancel') {
      obj.callCancel = message.body.callCancel
    }
    return obj
  },

  create<I extends Exact<DeepPartial<Packet>, I>>(base?: I): Packet {
    return Packet.fromPartial(base ?? ({} as any))
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
        callStart: CallStart.fromPartial(object.body.callStart),
      }
    }
    if (
      object.body?.$case === 'callData' &&
      object.body?.callData !== undefined &&
      object.body?.callData !== null
    ) {
      message.body = {
        $case: 'callData',
        callData: CallData.fromPartial(object.body.callData),
      }
    }
    if (
      object.body?.$case === 'callCancel' &&
      object.body?.callCancel !== undefined &&
      object.body?.callCancel !== null
    ) {
      message.body = { $case: 'callCancel', callCancel: object.body.callCancel }
    }
    return message
  },
}

function createBaseCallStart(): CallStart {
  return {
    rpcService: '',
    rpcMethod: '',
    data: new Uint8Array(0),
    dataIsZero: false,
  }
}

export const CallStart = {
  encode(
    message: CallStart,
    writer: _m0.Writer = _m0.Writer.create(),
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
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseCallStart()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break
          }

          message.rpcService = reader.string()
          continue
        case 2:
          if (tag !== 18) {
            break
          }

          message.rpcMethod = reader.string()
          continue
        case 3:
          if (tag !== 26) {
            break
          }

          message.data = reader.bytes()
          continue
        case 4:
          if (tag !== 32) {
            break
          }

          message.dataIsZero = reader.bool()
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
  // Transform<CallStart, Uint8Array>
  async *encodeTransform(
    source:
      | AsyncIterable<CallStart | CallStart[]>
      | Iterable<CallStart | CallStart[]>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [CallStart.encode(p).finish()]
        }
      } else {
        yield* [CallStart.encode(pkt as any).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, CallStart>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>,
  ): AsyncIterable<CallStart> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [CallStart.decode(p)]
        }
      } else {
        yield* [CallStart.decode(pkt as any)]
      }
    }
  },

  fromJSON(object: any): CallStart {
    return {
      rpcService: isSet(object.rpcService)
        ? globalThis.String(object.rpcService)
        : '',
      rpcMethod: isSet(object.rpcMethod)
        ? globalThis.String(object.rpcMethod)
        : '',
      data: isSet(object.data)
        ? bytesFromBase64(object.data)
        : new Uint8Array(0),
      dataIsZero: isSet(object.dataIsZero)
        ? globalThis.Boolean(object.dataIsZero)
        : false,
    }
  },

  toJSON(message: CallStart): unknown {
    const obj: any = {}
    if (message.rpcService !== '') {
      obj.rpcService = message.rpcService
    }
    if (message.rpcMethod !== '') {
      obj.rpcMethod = message.rpcMethod
    }
    if (message.data.length !== 0) {
      obj.data = base64FromBytes(message.data)
    }
    if (message.dataIsZero === true) {
      obj.dataIsZero = message.dataIsZero
    }
    return obj
  },

  create<I extends Exact<DeepPartial<CallStart>, I>>(base?: I): CallStart {
    return CallStart.fromPartial(base ?? ({} as any))
  },
  fromPartial<I extends Exact<DeepPartial<CallStart>, I>>(
    object: I,
  ): CallStart {
    const message = createBaseCallStart()
    message.rpcService = object.rpcService ?? ''
    message.rpcMethod = object.rpcMethod ?? ''
    message.data = object.data ?? new Uint8Array(0)
    message.dataIsZero = object.dataIsZero ?? false
    return message
  },
}

function createBaseCallData(): CallData {
  return {
    data: new Uint8Array(0),
    dataIsZero: false,
    complete: false,
    error: '',
  }
}

export const CallData = {
  encode(
    message: CallData,
    writer: _m0.Writer = _m0.Writer.create(),
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
    const reader =
      input instanceof _m0.Reader ? input : _m0.Reader.create(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseCallData()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break
          }

          message.data = reader.bytes()
          continue
        case 2:
          if (tag !== 16) {
            break
          }

          message.dataIsZero = reader.bool()
          continue
        case 3:
          if (tag !== 24) {
            break
          }

          message.complete = reader.bool()
          continue
        case 4:
          if (tag !== 34) {
            break
          }

          message.error = reader.string()
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
  // Transform<CallData, Uint8Array>
  async *encodeTransform(
    source:
      | AsyncIterable<CallData | CallData[]>
      | Iterable<CallData | CallData[]>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [CallData.encode(p).finish()]
        }
      } else {
        yield* [CallData.encode(pkt as any).finish()]
      }
    }
  },

  // decodeTransform decodes a source of encoded messages.
  // Transform<Uint8Array, CallData>
  async *decodeTransform(
    source:
      | AsyncIterable<Uint8Array | Uint8Array[]>
      | Iterable<Uint8Array | Uint8Array[]>,
  ): AsyncIterable<CallData> {
    for await (const pkt of source) {
      if (globalThis.Array.isArray(pkt)) {
        for (const p of pkt as any) {
          yield* [CallData.decode(p)]
        }
      } else {
        yield* [CallData.decode(pkt as any)]
      }
    }
  },

  fromJSON(object: any): CallData {
    return {
      data: isSet(object.data)
        ? bytesFromBase64(object.data)
        : new Uint8Array(0),
      dataIsZero: isSet(object.dataIsZero)
        ? globalThis.Boolean(object.dataIsZero)
        : false,
      complete: isSet(object.complete)
        ? globalThis.Boolean(object.complete)
        : false,
      error: isSet(object.error) ? globalThis.String(object.error) : '',
    }
  },

  toJSON(message: CallData): unknown {
    const obj: any = {}
    if (message.data.length !== 0) {
      obj.data = base64FromBytes(message.data)
    }
    if (message.dataIsZero === true) {
      obj.dataIsZero = message.dataIsZero
    }
    if (message.complete === true) {
      obj.complete = message.complete
    }
    if (message.error !== '') {
      obj.error = message.error
    }
    return obj
  },

  create<I extends Exact<DeepPartial<CallData>, I>>(base?: I): CallData {
    return CallData.fromPartial(base ?? ({} as any))
  },
  fromPartial<I extends Exact<DeepPartial<CallData>, I>>(object: I): CallData {
    const message = createBaseCallData()
    message.data = object.data ?? new Uint8Array(0)
    message.dataIsZero = object.dataIsZero ?? false
    message.complete = object.complete ?? false
    message.error = object.error ?? ''
    return message
  },
}

function bytesFromBase64(b64: string): Uint8Array {
  if (globalThis.Buffer) {
    return Uint8Array.from(globalThis.Buffer.from(b64, 'base64'))
  } else {
    const bin = globalThis.atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; ++i) {
      arr[i] = bin.charCodeAt(i)
    }
    return arr
  }
}

function base64FromBytes(arr: Uint8Array): string {
  if (globalThis.Buffer) {
    return globalThis.Buffer.from(arr).toString('base64')
  } else {
    const bin: string[] = []
    arr.forEach((byte) => {
      bin.push(globalThis.String.fromCharCode(byte))
    })
    return globalThis.btoa(bin.join(''))
  }
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
