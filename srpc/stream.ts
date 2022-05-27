import type { Packet } from './rpcproto'
import type { Writer } from './writer'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// Stream is an open connection with a writer and a handler.
export interface Stream {
  // getWriter returns the connection writer.
  getWriter(): Writer
  // setPacketHandler sets the packet handler.
  setPacketHandler(handler: PacketHandler): void
}

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<Stream>
