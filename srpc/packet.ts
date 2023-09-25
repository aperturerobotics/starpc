import {
  encode as lengthPrefixEncode,
  decode as lengthPrefixDecode,
} from 'it-length-prefixed'
import { Uint8ArrayList } from 'uint8arraylist'

import { Packet } from './rpcproto.pb.js'
import {
  buildDecodeMessageTransform,
  buildEncodeMessageTransform,
} from './message.js'
import { Source, Transform } from 'it-stream-types'

// decodePacketSource decodes packets from a binary data stream.
export const decodePacketSource = buildDecodeMessageTransform<Packet>(Packet)

// encodePacketSource encodes packets from a packet object stream.
export const encodePacketSource = buildEncodeMessageTransform<Packet>(Packet)

// uint32LEDecode removes the length prefix.
const uint32LEDecode = (data: Uint8ArrayList) => {
  if (data.length < 4) {
    throw RangeError('Could not decode int32BE')
  }

  return data.getUint32(0, true)
}
uint32LEDecode.bytes = 4

// uint32LEEncode adds the length prefix.
const uint32LEEncode = (value: number) => {
  const data = new Uint8ArrayList(new Uint8Array(4))
  data.setUint32(0, value, true)
  return data
}
uint32LEEncode.bytes = 4

// prependLengthPrefixTransform adds a length prefix to a message source.
// little-endian uint32
export function prependLengthPrefixTransform(): Transform<
  Source<Uint8Array | Uint8ArrayList>,
  | AsyncGenerator<Uint8Array, void, undefined>
  | Generator<Uint8Array, void, undefined>
> {
  return (source: Source<Uint8Array | Uint8ArrayList>) => {
    return lengthPrefixEncode(source, { lengthEncoder: uint32LEEncode })
  }
}

// parseLengthPrefixTransform parses the length prefix from a message source.
// little-endian uint32
export function parseLengthPrefixTransform(): Transform<
  Source<Uint8Array | Uint8ArrayList>, // Allow both AsyncIterable and Iterable
  | AsyncGenerator<Uint8ArrayList, void, unknown>
  | Generator<Uint8ArrayList, void, unknown>
> {
  return (source: Source<Uint8Array | Uint8ArrayList>) => {
    return lengthPrefixDecode(source, { lengthDecoder: uint32LEDecode })
  }
}

// encodeUint32Le encodes the number as a uint32 with little endian.
export function encodeUint32Le(value: number): Uint8Array {
  // output is a 4 byte array
  const output = new Uint8Array(4)
  for (let index = 0; index < output.length; index++) {
    const b = value & 0xff
    output[index] = b
    value = (value - b) / 256
  }
  return output
}

// decodeUint32Le decodes a uint32 from a 4 byte Uint8Array.
// returns 0 if decoding failed.
// callers should check that len(data) == 4
export function decodeUint32Le(data: Uint8Array): number {
  let value = 0
  let nbytes = 4
  if (data.length < nbytes) {
    nbytes = data.length
  }
  for (let i = nbytes - 1; i >= 0; i--) {
    value = value * 256 + data[i]
  }
  return value
}

// prependPacketLen adds the message length prefix to a packet.
export function prependPacketLen(msgData: Uint8Array): Uint8Array {
  const msgLen = msgData.length
  const msgLenData = encodeUint32Le(msgLen)
  const merged = new Uint8Array(msgLen + msgLenData.length)
  merged.set(msgLenData)
  merged.set(msgData, msgLenData.length)
  return merged
}
