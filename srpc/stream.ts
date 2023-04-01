import type { Packet } from './rpcproto.pb.js'
import type { Duplex } from 'it-stream-types'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// Stream is an open connection duplex.
export type Stream = Duplex<Uint8Array>

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<Stream>
