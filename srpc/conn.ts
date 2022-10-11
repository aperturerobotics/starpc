import type { Direction, Stream } from '@libp2p/interface-connection'
import type {
  StreamMuxer,
  StreamMuxerFactory,
} from '@libp2p/interface-stream-muxer'
import { pipe } from 'it-pipe'
import type { Duplex } from 'it-stream-types'
import { Mplex } from '@libp2p/mplex'
import { Uint8ArrayList } from 'uint8arraylist'

import type { OpenStreamFunc, Stream as SRPCStream } from './stream.js'
import { Client } from './client.js'
import { combineUint8ArrayListTransform } from './array-list.js'

// ConnParams are parameters that can be passed to the Conn constructor.
export interface ConnParams {
  // muxerFactory overrides using the default factory (@libp2p/mplex).
  muxerFactory?: StreamMuxerFactory
  // direction is the muxer connection direction.
  // defaults to outbound.
  direction?: Direction
}

// StreamHandler handles incoming streams.
// Implemented by Server.
export interface StreamHandler {
  // handleStream handles an incoming stream.
  handleStream(strm: SRPCStream): void
}

// streamToSRPCStream converts a Stream to a SRPCStream.
export function streamToSRPCStream(
  stream: Duplex<Uint8ArrayList, Uint8ArrayList | Uint8Array>
): SRPCStream {
  return {
    source: pipe(stream, combineUint8ArrayListTransform()),
    sink: stream.sink,
  }
}

// Conn implements a generic connection with a two-way stream.
// Implements the client by opening streams with the remote.
// Implements the server by handling incoming streams.
// If the server is unset, rejects any incoming streams.
export class Conn implements Duplex<Uint8Array> {
  // muxer is the mplex stream muxer.
  private muxer: StreamMuxer
  // server is the server side, if set.
  private server?: StreamHandler

  constructor(server?: StreamHandler, connParams?: ConnParams) {
    if (server) {
      this.server = server
    }
    let muxerFactory = connParams?.muxerFactory
    if (!muxerFactory) {
      muxerFactory = new Mplex()
    }
    this.muxer = muxerFactory.createStreamMuxer({
      onIncomingStream: this.handleIncomingStream.bind(this),
      direction: connParams?.direction || 'outbound',
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
    return streamToSRPCStream(stream)
  }

  // buildOpenStreamFunc returns openStream bound to this conn.
  public buildOpenStreamFunc(): OpenStreamFunc {
    return this.openStream.bind(this)
  }

  // handleIncomingStream handles an incoming stream.
  private handleIncomingStream(strm: Stream) {
    const server = this.server
    if (!server) {
      return strm.abort(new Error('server not implemented'))
    }
    server.handleStream(streamToSRPCStream(strm))
  }
}
