import { yamux } from '@chainsafe/libp2p-yamux'
import type {
  Direction,
  Stream,
  StreamMuxer,
  StreamMuxerFactory,
} from '@libp2p/interface'
import { pipe } from 'it-pipe'
import type { Duplex, Source } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'
import isPromise from 'is-promise'
import { pushable, Pushable } from 'it-pushable'
import { defaultLogger } from '@libp2p/logger'

import type { OpenStreamFunc, Stream as SRPCStream } from './stream.js'
import { Client } from './client.js'
import { combineUint8ArrayListTransform } from './array-list.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet.js'
import { buildPushableSink } from './pushable.js'

// ConnParams are parameters that can be passed to the Conn constructor.
export interface ConnParams {
  // muxerFactory overrides using the default yamux factory.
  muxerFactory?: StreamMuxerFactory
  // direction is the muxer connection direction.
  // defaults to outbound (client).
  direction?: Direction
}

// StreamHandler handles incoming streams.
// Implemented by Server.
export interface StreamHandler {
  // handlePacketStream handles an incoming Uint8Array duplex.
  // the stream has one Uint8Array per packet w/o length prefix.
  handlePacketStream(strm: SRPCStream): void
}

// streamToSRPCStream converts a Stream to a SRPCStream.
// uses length-prefix for packet framing
export function streamToSRPCStream(
  stream: Duplex<
    AsyncIterable<Uint8ArrayList>,
    Source<Uint8ArrayList | Uint8Array>,
    Promise<void>
  >,
): SRPCStream {
  const pushSink: Pushable<Uint8Array> = pushable({ objectMode: true })
  pipe(pushSink, prependLengthPrefixTransform(), stream.sink)
  return {
    source: pipe(
      stream,
      parseLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
    ),
    sink: buildPushableSink(pushSink),
  }
}

// Conn implements a generic connection with a two-way stream.
// Implements the client by opening streams with the remote.
// Implements the server by handling incoming streams.
// If the server is unset, rejects any incoming streams.
export class Conn
  implements Duplex<AsyncGenerator<Uint8Array | Uint8ArrayList>>
{
  // muxer is the stream muxer.
  private muxer: StreamMuxer
  // server is the server side, if set.
  private server?: StreamHandler

  constructor(server?: StreamHandler, connParams?: ConnParams) {
    if (server) {
      this.server = server
    }
    const muxerFactory =
      connParams?.muxerFactory ??
      yamux({ enableKeepAlive: false })({
        logger: defaultLogger(),
      })
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
    const streamPromise = this.muxer.newStream()
    let stream: Stream
    if (isPromise(streamPromise)) {
      stream = await streamPromise
    } else {
      stream = streamPromise
    }
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
    server.handlePacketStream(streamToSRPCStream(strm))
  }
}
