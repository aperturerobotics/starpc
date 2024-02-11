import { Pushable } from 'it-pushable'
import { Sink, Source } from 'it-stream-types'

// writeToPushable writes the incoming server data to the pushable.
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
    throw err
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
