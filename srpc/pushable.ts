import { Pushable } from 'it-pushable'
import { Source, Sink } from 'it-stream-types'
import { castToError } from './errors.js'

// writeToPushable writes the incoming server data to the pushable.
export async function writeToPushable<T>(
  dataSource: AsyncIterable<T>,
  out: Pushable<T>
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

// buildPushableSink builds a Sink from a Pushable.
export function buildPushableSink<T>(target: Pushable<T>): Sink<T> {
  return async function pushableSink(source: Source<T>): Promise<void> {
    try {
      for await (const pkt of source) {
        if (Array.isArray(pkt)) {
          for (const p of pkt) {
            target.push(p)
          }
        } else {
          target.push(pkt)
        }
      }
      target.end()
    } catch (err) {
      const error = castToError(err)
      target.end(error)
    }
  }
}
