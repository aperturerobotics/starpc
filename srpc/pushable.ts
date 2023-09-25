import { Pushable } from 'it-pushable'
import { Source, Sink } from 'it-stream-types'

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

export function buildPushableSink<T extends Iterable<any> | AsyncIterable<any>>(
  target: Pushable<T>,
): Sink<Source<T>, Promise<void>>

export function buildPushableSink<T extends Iterable<any> | AsyncIterable<any>>(
  target: Pushable<T>,
): Sink<Source<T>, Promise<void>> {
  return async (source: Source<T>): Promise<void> => {
    if (Symbol.asyncIterator in source) {
      // Handle AsyncIterable
      for await (const pkt of source as AsyncIterable<any>) {
        processPacket(pkt, target)
      }
    } else {
      // Handle Iterable
      for (const pkt of source as Iterable<any>) {
        processPacket(pkt, target)
      }
    }
  }
}

function processPacket<T>(pkt: T, target: Pushable<T>): void {
  if (Array.isArray(pkt)) {
    for (const p of pkt) {
      target.push(p)
    }
  } else {
    target.push(pkt)
  }
}
