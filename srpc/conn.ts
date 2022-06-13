import type { Stream } from '@libp2p/interfaces/connection'
import type { Duplex } from 'it-stream-types'
import { Components } from '@libp2p/interfaces/components'
import { MplexStreamMuxer } from '@libp2p/mplex'
import type { Stream as SRPCStream } from './stream'
import { Client } from './client'

// ConnWriter is a function that writes a message to a connection.
export type ConnWriter = (data: Uint8Array) => Promise<void>

// Conn implements a generic connection with a two-way stream.
export class Conn implements Duplex<Uint8Array> {
  // muxer is the mplex stream muxer.
  private muxer: MplexStreamMuxer

  constructor() {
    // see https://github.com/libp2p/js-libp2p-mplex/pull/179
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
    return this.muxer.newStream()
  }

  // handleIncomingStream handles an incoming stream.
  private handleIncomingStream(strm: Stream) {
    strm.abort(new Error('server -> client streams not implemented'))
  }

  // handleStreamEnd handles a stream closing.
  private handleStreamEnd(_strm: Stream) {
    // noop
  }
}
