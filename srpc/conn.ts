import type { Stream } from '@libp2p/interfaces/connection'
import type { Duplex } from 'it-stream-types'
import { Components } from '@libp2p/interfaces/components'
import { MplexStreamMuxer } from '@libp2p/mplex/src/mplex'
import type { Stream as SRPCStream } from './stream'
import { Client } from './client'
import { Packet } from './rpcproto'

// ConnWriter is a function that writes a message to a connection.
export type ConnWriter = (data: Uint8Array) => Promise<void>

// Conn implements a generic connection with a two-way stream.
export class Conn implements Duplex<Uint8Array> {
  // muxer is the mplex stream muxer.
  private muxer: MplexStreamMuxer

  // calls is the list of ongoing rpc calls.
  // private calls: {[streamID: string]: Call}

  constructor() {
    this.muxer = new MplexStreamMuxer(new Components(), {
      onIncomingStream: this.handleIncomingStream.bind(this),
      onStreamEnd: this.handleStreamEnd.bind(this),
    })
  }

  // sink returns the message sink.
  get sink() {
    return this.muxer.sink
  }

  // source returns the outgoing message source.
  get source() {
    return this.muxer.source
  }

  // streams returns the set of all ongoing streams.
  get streams() {
    return this.muxer.streams
  }

  // buildClient builds a new client from the connection.
  public buildClient(): Client {
    return new Client(this.openStream.bind(this))
  }

  // openStream implements the client open stream function.
  public async openStream(): Promise<SRPCStream> {
    const stream = this.muxer.newStream()
    return {
      getWriter: () => {
        return {
          writePacket: async (packet: Packet) => {
            const data = Packet.encode(packet).finish()
          },
          close: {},
        }
      },
    } as SRPCStream
  }

  // handleIncomingStream handles an incoming stream.
  private handleIncomingStream(strm: Stream) {
    // TODO
    throw new Error('todo handle server-side in ts')
  }

  // handleStreamEnd handles a stream closing.
  private handleStreamEnd(strm: Stream) {
    // TODO
  }
}
