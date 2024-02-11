import type { Duplex, Source } from 'it-stream-types'
import { pipe } from 'it-pipe'
import { Stream } from '@libp2p/interface'

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
      await pipe(source, prependLengthPrefixTransform(), stream)
        .catch((err) => stream.close(err))
        .then(() => stream.close())
    },
  }
}
