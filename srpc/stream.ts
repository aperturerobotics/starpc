import type { Packet } from './rpcproto.pb.js'
import type { Duplex } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// Stream is an open connection.
export type Stream = Duplex<Uint8ArrayList | Uint8Array, Uint8Array>

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<Stream>

// streamToUint8ArrayDuplex converts a Stream to a Duplex<Uint8Array>
// This should be possible without the cast:
// https://github.com/achingbrain/it-stream-types/issues/28
export function streamToUint8ArrayDuplex(stream: Stream): Duplex<Uint8Array, Uint8Array> {
  return stream as Duplex<Uint8Array> // eslint-disable-line
}
