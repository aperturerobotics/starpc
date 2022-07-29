import type { Source } from 'it-stream-types'
import { isUint8ArrayList, Uint8ArrayList } from 'uint8arraylist'
import type { Transform } from 'it-stream-types'

// combineUint8ArrayListTransform combines a Uint8ArrayList into a Uint8Array.
export function combineUint8ArrayListTransform(): Transform<Uint8Array | Uint8ArrayList, Uint8Array> {
  // decodeMessageSource unmarshals and async yields encoded Messages.
  return async function* decodeMessageSource(
    source: Source<Uint8Array | Uint8ArrayList>
  ): AsyncIterable<Uint8Array> {
    for await (const obj of source) {
      if (isUint8ArrayList(obj)) {
        yield* [obj.subarray()]
      } else {
        yield* [obj]
      }
    }
  }
}
