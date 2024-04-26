import { Message } from '@aptre/protobuf-es-lite'
import { Pushable, pushable } from 'it-pushable'
import { Sink, Source } from 'it-stream-types'

// messagePushable is a shortcut to build a pushable for messages.
export function messagePushable<T extends Message<T>>(): Pushable<T> {
  return pushable<T>({ objectMode: true })
}

// writeToPushable writes the incoming server data to the pushable.
//
// this will not throw an error: it instead ends out w/ the error.
export async function writeToPushable<T>(
  dataSource: AsyncIterable<T>,
  out: Pushable<T>,
) {
  try {
    for await (const data of dataSource) {
      out.push(data)
    }
    out.end()
  } catch (err) {
    out.end(err as Error)
  }
}

export function buildPushableSink<T>(
  target: Pushable<T>,
): Sink<Source<T>, Promise<void>> {
  return async (source: Source<T>): Promise<void> => {
    try {
      if (Symbol.asyncIterator in source) {
        for await (const pkt of source) {
          target.push(pkt)
        }
      } else {
        for (const pkt of source) {
          target.push(pkt)
        }
      }
      target.end()
    } catch (err) {
      target.end(err as Error)
    }
  }
}
