import type { Duplex, Source } from 'it-stream-types'
import { pipe } from 'it-pipe'
import type { Stream } from '@libp2p/interface'

import type { Packet } from './rpcproto.pb.js'
import { combineUint8ArrayListTransform } from './array-list.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet.js'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// PacketStream represents a stream of packets where each Uint8Array represents one packet.
export type PacketStream = Duplex<
  AsyncGenerator<Uint8Array>,
  Source<Uint8Array>,
  Promise<void>
>

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<PacketStream>

// HandleStreamFunc handles an incoming RPC stream.
// Returns as soon as the stream has been passed off to be handled.
// Throws an error if we can't handle the incoming stream.
export type HandleStreamFunc = (ch: PacketStream) => Promise<void>

// streamToPacketStream converts a Stream into a PacketStream using length-prefix framing.
//
// The stream is closed when the source writing to the sink ends.
export function streamToPacketStream(stream: Stream): PacketStream {
  return {
    source: pipe(
      stream,
      parseLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
    ),
    sink: async (source: Source<Uint8Array>): Promise<void> => {
      try {
        for await (const data of pipe(source, prependLengthPrefixTransform())) {
          stream.send(data)
        }
        await stream.close()
      } catch {
        await stream
          .close({ signal: AbortSignal.timeout(1000) })
          .catch(() => {})
      }
    },
  }
}
