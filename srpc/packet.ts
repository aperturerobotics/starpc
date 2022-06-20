import type { Transform } from 'it-stream-types'
import {
  encode as lengthPrefixEncode,
  decode as lengthPrefixDecode,
} from 'it-length-prefixed'

import { Packet } from './rpcproto.js'
import {
  buildDecodeMessageTransform,
  buildEncodeMessageTransform,
} from './message.js'

// decodePacketSource decodes packets from a binary data stream.
export const decodePacketSource = buildDecodeMessageTransform<Packet>(Packet)

// encodePacketSource encodes packets from a packet object stream.
export const encodePacketSource = buildEncodeMessageTransform<Packet>(Packet)

// uint32LEDecode removes the length prefix.
const uint32LEDecode = (data: Uint8Array) => {
  if (data.length < 4) {
    throw RangeError('Could not decode int32BE')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getUint32(0, true)
}
uint32LEDecode.bytes = 4

// uint32LEEncode adds the length prefix.
const uint32LEEncode = (
  value: number,
  target?: Uint8Array,
  offset?: number
) => {
  target = target ?? new Uint8Array(4)
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  view.setUint32(offset ?? 0, value, true)
  return target
}
uint32LEEncode.bytes = 4

// prependLengthPrefixTransform adds a length prefix to a message source.
// little-endian uint32
export function prependLengthPrefixTransform(): Transform<Uint8Array> {
  return lengthPrefixEncode({ lengthEncoder: uint32LEEncode })
}

// parseLengthPrefixTransform parses the length prefix from a message source.
// little-endian uint32
export function parseLengthPrefixTransform(): Transform<Uint8Array> {
  return lengthPrefixDecode({ lengthDecoder: uint32LEDecode })
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

/*
// buildCallDataPacket builds a CallData packet.
function buildCallDataPacket(data: Uint8Array): Packet {
  const callData: CallData = {
    data: p,
    complete: false,
    error: '',
  }
  const pkt: Packet = {
    body: {
      $case: 'callData',
      callData: callData,
    }
  }
  return pkt
}

// wrapCallDataTransform is a transformer that wraps call data into a Packet.
export async function* wrapCallDataTransform(
  source: Source<Uint8Array | Uint8Array>
): AsyncIterable<Packet> {
  for await (const pkt of source) {
    if (Array.isArray(pkt)) {
      for (const p of pkt) {
        yield* [buildCallDataPacket(p)]
      }
    } else {
      yield* [buildCallDataPacket(pkt)]
    }
  }
}
*/
