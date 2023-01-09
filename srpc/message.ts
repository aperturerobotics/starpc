import * as pbjs from 'protobufjs/minimal'
import type { Source } from 'it-stream-types'

// MessageDefinition represents a ts-proto message definition.
export interface MessageDefinition<T> {
  // encode encodes the message and returns writer.
  encode(message: T, writer?: pbjs.Writer): pbjs.Writer
  // decode decodes the message from the reader
  decode(input: pbjs.Reader | Uint8Array, length?: number): T
}

// DecodeMessageTransform decodes messages to objects.
export type DecodeMessageTransform<T> = (
  source: Source<Uint8Array | Uint8Array[]>
) => AsyncIterable<T>

// buildDecodeMessageTransform builds a source of decoded messages.
export function buildDecodeMessageTransform<T>(
  def: MessageDefinition<T>
): DecodeMessageTransform<T> {
  // decodeMessageSource unmarshals and async yields encoded Messages.
  return async function* decodeMessageSource(
    source: Source<Uint8Array | Uint8Array[]>
  ): AsyncIterable<T> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [def.decode(p)]
        }
      } else {
        yield* [def.decode(pkt)]
      }
    }
  }
}

// EncodeMessageTransform is a transformer that encodes messages.
export type EncodeMessageTransform<T> = (
  source: Source<T | T[]>
) => AsyncIterable<Uint8Array>

// buildEncodeMessageTransform builds a source of decoded messages.
export function buildEncodeMessageTransform<T>(
  def: MessageDefinition<T>
): EncodeMessageTransform<T> {
  // encodeMessageSource encodes messages to byte arrays.
  return async function* encodeMessageSource(
    source: Source<T | T[]>
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield* [def.encode(p).finish()]
        }
      } else {
        yield* [def.encode(pkt).finish()]
      }
    }
  }
}
