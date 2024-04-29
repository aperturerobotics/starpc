import { MessageType, Message } from '@aptre/protobuf-es-lite'
import type { Source } from 'it-stream-types'

// MessageStream is an async iterable of partial messages.
export type MessageStream<T extends Message<T>> = AsyncIterable<T>

// DecodeMessageTransform decodes messages to objects.
export type DecodeMessageTransform<T> = (
  source: Source<Uint8Array | Uint8Array[]>,
) => AsyncIterable<T>

// buildDecodeMessageTransform builds a source of decoded messages.
export function buildDecodeMessageTransform<T extends Message<T>>(
  def: MessageType<T>,
): DecodeMessageTransform<T> {
  const decode = def.fromBinary.bind(def)
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
export type EncodeMessageTransform<T extends Message<T>> = (
  source: Source<T | Array<T>>,
) => AsyncIterable<Uint8Array>

// buildEncodeMessageTransform builds a transformer that encodes messages.
export function buildEncodeMessageTransform<T extends Message<T>>(
  def: MessageType<T>,
): EncodeMessageTransform<T> {
  // encodeMessageSource marshals and async yields Messages.
  return async function* encodeMessageSource(
    source: Source<T | Array<T>>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield def.toBinary(p)
        }
      } else {
        yield def.toBinary(pkt)
      }
    }
  }
}
