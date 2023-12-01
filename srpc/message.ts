import * as pbjs from 'protobufjs/minimal'
import type { Source } from 'it-stream-types'
import memoize from 'memoize-one'

// MessageDefinition represents a ts-proto message definition.
export interface MessageDefinition<T> {
  // create creates a full message from a partial and/or no message.
  create(msg?: Partial<T>): T
  // encode encodes the message and returns writer.
  encode(message: T, writer?: pbjs.Writer): pbjs.Writer
  // decode decodes the message from the reader
  decode(input: pbjs.Reader | Uint8Array, length?: number): T
}

// memoProto returns a function that encodes the message and caches the result.
export function memoProto<T>(
  def: MessageDefinition<T>,
): (msg: Partial<T>) => Uint8Array {
  return memoize((msg: Partial<T>): Uint8Array => {
    return def.encode(def.create(msg)).finish()
  })
}

// memoProtoDecode returns a function that decodes the message and caches the result.
export function memoProtoDecode<T>(
  def: MessageDefinition<T>,
): (msg: Uint8Array) => T {
  return memoize((msg: Uint8Array): T => {
    return def.decode(msg)
  })
}

// DecodeMessageTransform decodes messages to objects.
export type DecodeMessageTransform<T> = (
  source: Source<Uint8Array | Uint8Array[]>,
) => AsyncIterable<T>

// buildDecodeMessageTransform builds a source of decoded messages.
//
// set memoize if you expect to repeatedly see the same message.
export function buildDecodeMessageTransform<T>(
  def: MessageDefinition<T>,
  memoize?: boolean,
): DecodeMessageTransform<T> {
  const decode = !memoize ? def.decode.bind(def) : memoProtoDecode(def)

  // decodeMessageSource unmarshals and async yields encoded Messages.
  return async function* decodeMessageSource(
    source: Source<Uint8Array | Uint8Array[]>,
  ): AsyncIterable<T> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [decode(p)]
        }
      } else {
        yield* [decode(pkt)]
      }
    }
  }
}

// EncodeMessageTransform is a transformer that encodes messages.
export type EncodeMessageTransform<T> = (
  source: Source<T | T[]>,
) => AsyncIterable<Uint8Array>

// buildEncodeMessageTransform builds a source of decoded messages.
// set memoize if you expect to repeatedly encode the same message.
export function buildEncodeMessageTransform<T>(
  def: MessageDefinition<T>,
  memoize?: boolean,
): EncodeMessageTransform<T> {
  const encode = !memoize
    ? (msg: T): Uint8Array => {
        return def.encode(msg).finish()
      }
    : memoProto(def)

  // encodeMessageSource encodes messages to byte arrays.
  return async function* encodeMessageSource(
    source: Source<T | T[]>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [encode(p)]
        }
      } else {
        yield* [encode(pkt)]
      }
    }
  }
}
