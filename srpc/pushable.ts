import { Pushable } from 'it-pushable'

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
