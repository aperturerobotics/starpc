import type { Packet } from './rpcproto'

// Writer is the interface that Client uses to write messages.
export interface Writer {
  // writePacket writes a packet to the stream.
  writePacket(packet: Packet): Promise<void>
  // close closes the stream.
  close(): void
}
