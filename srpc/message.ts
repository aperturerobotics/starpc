import { MessageType, Message } from '@aptre/protobuf-es-lite'
import type { Source } from 'it-stream-types'
import memoize from 'memoize-one'

// MessageStream is an async iterable of partial messages.
export type MessageStream<T extends Message<T>> = AsyncIterable<Message<T>>

// memoProto returns a function that encodes the message and caches the result.
export function memoProto<T extends Message<T>>(
  def: MessageType<T>,
): (msg: Message<T>) => Uint8Array {
  return memoize((msg: Message<T>): Uint8Array => {
    return def.toBinary(def.create(msg))
  })
}

// memoProtoDecode returns a function that decodes the message and caches the result.
export function memoProtoDecode<T extends Message<T>>(
  def: MessageType<T>,
): (msg: Uint8Array) => T {
  return memoize((msg: Uint8Array): T => {
    return def.fromBinary(msg)
  })
}

// DecodeMessageTransform decodes messages to objects.
export type DecodeMessageTransform<T> = (
  source: Source<Uint8Array | Uint8Array[]>,
) => AsyncIterable<T>

// buildDecodeMessageTransform builds a source of decoded messages.
//
// set memoize if you expect to repeatedly see the same message.
export function buildDecodeMessageTransform<T extends Message<T>>(
  def: MessageType<T>,
  memoize?: boolean,
): DecodeMessageTransform<T> {
  const decode = !memoize ? def.fromBinary.bind(def) : memoProtoDecode(def)
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
  source: Source<Message<T> | Array<Message<T>>>,
) => AsyncIterable<Uint8Array>

// buildEncodeMessageTransform builds a transformer that encodes messages.
export function buildEncodeMessageTransform<T extends Message<T>>(
  def: MessageType<T>,
): EncodeMessageTransform<T> {
  // encodeMessageSource marshals and async yields Messages.
  return async function* encodeMessageSource(
    source: Source<Message<T> | Array<Message<T>>>,
  ): AsyncIterable<Uint8Array> {
    for await (const pkt of source) {
      if (Array.isArray(pkt)) {
        for (const p of pkt) {
          yield def.toBinary(def.create(p))
        }
      } else {
        yield def.toBinary(def.create(pkt))
      }
    }
  }
}
