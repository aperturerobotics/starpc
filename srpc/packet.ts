import type { Source } from 'it-stream-types'
import { Packet } from './rpcproto'

// decodePacketSource unmarshals and async yields encoded Packets.
export async function* decodePacketSource(
  source: Source<Uint8Array | Uint8Array[]>
): AsyncIterable<Packet> {
  for await (const pkt of source) {
    if (Array.isArray(pkt)) {
      for (const p of pkt) {
        yield* [Packet.decode(p)]
      }
    } else {
      yield* [Packet.decode(pkt)]
    }
  }
}

// encodePacketSource marshals and async yields packets.
export async function* encodePacketSource(
  source: Source<Packet | Packet[]>
): AsyncIterable<Uint8Array> {
  for await (const pkt of source) {
    if (Array.isArray(pkt)) {
      for (const p of pkt) {
        yield* [Packet.encode(p).finish()]
      }
    } else {
      yield* [Packet.encode(pkt).finish()]
    }
  }
}
