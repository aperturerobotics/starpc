/* eslint-disable */
import Long from 'long'
import * as _m0 from 'protobufjs/minimal'

export const protobufPackage = 'rpcstream'

/** RpcStreamPacket is a packet encapsulating data for a RPC stream. */
export interface RpcStreamPacket {
  body?:
    | { $case: 'init'; init: RpcStreamInit }
    | { $case: 'data'; data: Uint8Array }
}

/** RpcStreamInit is the first message in a RPC stream. */
export interface RpcStreamInit {
  /** ComponentId is the identifier of the component making the request. */
  componentId: string
}

function createBaseRpcStreamPacket(): RpcStreamPacket {
  return { body: undefined }
}

export const RpcStreamPacket = {
  encode(
    message: RpcStreamPacket,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.body?.$case === 'init') {
      RpcStreamInit.encode(message.body.init, writer.uint32(10).fork()).ldelim()
    }
    if (message.body?.$case === 'data') {
      writer.uint32(18).bytes(message.body.data)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): RpcStreamPacket {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseRpcStreamPacket()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.body = {
            $case: 'init',
            init: RpcStreamInit.decode(reader, reader.uint32()),
          }
          break
        case 2:
          message.body = { $case: 'data', data: reader.bytes() }
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  fromJSON(object: any): RpcStreamPacket {
    return {
      body: isSet(object.init)
        ? { $case: 'init', init: RpcStreamInit.fromJSON(object.init) }
        : isSet(object.data)
        ? { $case: 'data', data: bytesFromBase64(object.data) }
        : undefined,
    }
  },

  toJSON(message: RpcStreamPacket): unknown {
    const obj: any = {}
    message.body?.$case === 'init' &&
      (obj.init = message.body?.init
        ? RpcStreamInit.toJSON(message.body?.init)
        : undefined)
    message.body?.$case === 'data' &&
      (obj.data =
        message.body?.data !== undefined
          ? base64FromBytes(message.body?.data)
          : undefined)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<RpcStreamPacket>, I>>(
    object: I
  ): RpcStreamPacket {
    const message = createBaseRpcStreamPacket()
    if (
      object.body?.$case === 'init' &&
      object.body?.init !== undefined &&
      object.body?.init !== null
    ) {
      message.body = {
        $case: 'init',
        init: RpcStreamInit.fromPartial(object.body.init),
      }
    }
    if (
      object.body?.$case === 'data' &&
      object.body?.data !== undefined &&
      object.body?.data !== null
    ) {
      message.body = { $case: 'data', data: object.body.data }
    }
    return message
  },
}

function createBaseRpcStreamInit(): RpcStreamInit {
  return { componentId: '' }
}

export const RpcStreamInit = {
  encode(
    message: RpcStreamInit,
    writer: _m0.Writer = _m0.Writer.create()
  ): _m0.Writer {
    if (message.componentId !== '') {
      writer.uint32(10).string(message.componentId)
    }
    return writer
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): RpcStreamInit {
    const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input)
    let end = length === undefined ? reader.len : reader.pos + length
    const message = createBaseRpcStreamInit()
    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          message.componentId = reader.string()
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }
    return message
  },

  fromJSON(object: any): RpcStreamInit {
    return {
      componentId: isSet(object.componentId) ? String(object.componentId) : '',
    }
  },

  toJSON(message: RpcStreamInit): unknown {
    const obj: any = {}
    message.componentId !== undefined && (obj.componentId = message.componentId)
    return obj
  },

  fromPartial<I extends Exact<DeepPartial<RpcStreamInit>, I>>(
    object: I
  ): RpcStreamInit {
    const message = createBaseRpcStreamInit()
    message.componentId = object.componentId ?? ''
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
