import type { Source } from 'it-stream-types'
import { Message, PartialMessage, MessageType } from '@bufbuild/protobuf'
import memoize from 'memoize-one'

// memoProto returns a function that encodes the message and caches the result.
export function memoProto<T extends Message<T>>(
  def: MessageType<T>,
): (msg: PartialMessage<T>) => Uint8Array {
  return memoize((msg: PartialMessage<T>): Uint8Array => {
    return new def(msg).toBinary()
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
export type EncodeMessageTransform<T extends Message> = (
  source: Source<T | T[]>,
) => AsyncIterable<Uint8Array>

export async function* buildEncodeMessageTransform<T extends Message>(
  source: AsyncIterable<T | T[]> | Iterable<T | T[]>,
): AsyncIterable<Uint8Array> {
  for await (const pkt of source) {
    if (Array.isArray(pkt)) {
      for (const p of pkt) {
        yield p.toBinary()
      }
    } else {
      yield pkt.toBinary()
    }
  }
}
