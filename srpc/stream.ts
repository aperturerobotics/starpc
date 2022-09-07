import type { Packet } from './rpcproto.pb.js'
import type { Duplex } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// Stream is an open connection.
export type Stream = Duplex<Uint8ArrayList | Uint8Array, Uint8Array>

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<Stream>
