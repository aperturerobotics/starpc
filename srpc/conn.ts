import type { Stream } from '@libp2p/interface-connection'
import type { StreamMuxer, StreamMuxerFactory } from '@libp2p/interface-stream-muxer'
import type { Duplex } from 'it-stream-types'
import { Mplex } from '@libp2p/mplex'
import type { Stream as SRPCStream } from './stream'
import { Client } from './client'

// ConnParams are parameters that can be passed to the Conn constructor.
export interface ConnParams {
  // muxerFactory overrides using the default factory (@libp2p/mplex).
  muxerFactory?: StreamMuxerFactory
}

// Conn implements a generic connection with a two-way stream.
export class Conn implements Duplex<Uint8Array> {
  // muxer is the mplex stream muxer.
  private muxer: StreamMuxer

  constructor(connParams?: ConnParams) {
    let muxerFactory = connParams?.muxerFactory
    if (!muxerFactory) {
      muxerFactory = new Mplex()
    }
    this.muxer = muxerFactory.createStreamMuxer({
      onIncomingStream: this.handleIncomingStream.bind(this),
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
}
