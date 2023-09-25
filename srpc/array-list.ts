import type { Source, Transform } from 'it-stream-types'
import { isUint8ArrayList, Uint8ArrayList } from 'uint8arraylist'

// combineUint8ArrayListTransform combines a Uint8ArrayList into a Uint8Array.
export function combineUint8ArrayListTransform(): Transform<
  Source<Uint8Array | Uint8ArrayList>,
  AsyncGenerator<Uint8Array>
> {
  return async function* decodeMessageSource(
    source: Source<Uint8Array | Uint8ArrayList>,
  ): AsyncGenerator<Uint8Array> {
    for await (const obj of source) {
      if (isUint8ArrayList(obj)) {
        yield obj.subarray()
      } else {
        yield obj
      }
    }
  }
}
