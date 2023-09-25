import type { Packet } from './rpcproto.pb.js'
import type { Duplex, Source } from 'it-stream-types'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// Stream is an open connection.
// This stream type assumes that each Uint8Array corresponds to a Packet.
export type Stream<T = Uint8Array> = Duplex<
  AsyncGenerator<T>,
  Source<T>,
  Promise<void>
>

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<Stream>
