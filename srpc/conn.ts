import { YamuxMuxerInit, yamux } from '@chainsafe/libp2p-yamux'
import type {
  ComponentLogger,
  MessageStreamDirection,
  Stream,
  StreamMuxer,
  StreamMuxerFactory,
} from '@libp2p/interface'
import type { Duplex, Source } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'

import {
  streamToPacketStream,
  type OpenStreamFunc,
  type PacketStream,
} from './stream.js'
import { Client } from './client.js'
import {
  DuplexMessageStream,
  createDuplexMessageStream,
} from './duplex-message-stream.js'

// ConnParams are parameters that can be passed to the StreamConn constructor.
export interface StreamConnParams {
  // logger is the logger to use, defaults to disabled logger.
  logger?: ComponentLogger
  // muxerFactory overrides using the default yamux factory.
  muxerFactory?: StreamMuxerFactory
  // direction is the muxer connection direction.
  // defaults to outbound (client).
  direction?: MessageStreamDirection
  // yamuxParams are parameters to pass to yamux.
  // only used if muxerFactory is unset
  yamuxParams?: YamuxMuxerInit
}

// StreamHandler handles incoming streams.
// Implemented by Server.
export interface StreamHandler {
  // handlePacketStream handles an incoming Uint8Array duplex.
  // the stream has one Uint8Array per packet w/o length prefix.
  handlePacketStream(strm: PacketStream): void
}

// StreamConn implements a generic connection with a two-way stream.
// The stream is not expected to manage packet boundaries.
// Packets will be sent with uint32le length prefixes.
// Uses Yamux to manage streams over the connection.
//
// Implements the client by opening streams with the remote.
// Implements the server by handling incoming streams.
// If the server is unset, rejects any incoming streams.
export class StreamConn
  implements
    Duplex<
      AsyncIterable<Uint8Array | Uint8ArrayList>,
      Source<Uint8Array | Uint8ArrayList>,
      Promise<void>
    >
{
  // muxer is the stream muxer.
  private _muxer: StreamMuxer
  // messageStream wraps the duplex as a MessageStream for the muxer.
  private _messageStream: DuplexMessageStream
  // server is the server side, if set.
  private _server?: StreamHandler

  constructor(server?: StreamHandler, connParams?: StreamConnParams) {
    if (server) {
      this._server = server
    }

    // Create the MessageStream adapter
    const direction = connParams?.direction || 'outbound'
    this._messageStream = createDuplexMessageStream({
      log: connParams?.logger?.forComponent('stream-conn'),
      direction,
    })

    // Create the muxer factory - yamux(init)() returns a StreamMuxerFactory
    const muxerFactory =
      connParams?.muxerFactory ??
      yamux({ enableKeepAlive: false, ...connParams?.yamuxParams })()

    // Create the muxer with the MessageStream
    this._muxer = muxerFactory.createStreamMuxer(this._messageStream)

    // Listen for incoming streams
    this._muxer.addEventListener('stream', (evt) => {
      this.handleIncomingStream(evt.detail)
    })
  }

  // sink returns the message sink.
  get sink(): (source: Source<Uint8Array | Uint8ArrayList>) => Promise<void> {
    return this._messageStream.sink
  }

  // source returns the outgoing message source.
  get source(): AsyncIterable<Uint8Array | Uint8ArrayList> {
    return this._messageStream.source
  }

  // streams returns the set of all ongoing streams.
  get streams() {
    return this._muxer.streams
  }

  // muxer returns the muxer
  get muxer() {
    return this._muxer
  }

  // server returns the server, if any.
  get server() {
    return this._server
  }

  // buildClient builds a new client from the connection.
  public buildClient(): Client {
    return new Client(this.openStream.bind(this))
  }

  // openStream implements the client open stream function.
  public async openStream(): Promise<PacketStream> {
    const strm = await this.muxer.createStream()
    return streamToPacketStream(strm)
  }

  // buildOpenStreamFunc returns openStream bound to this conn.
  public buildOpenStreamFunc(): OpenStreamFunc {
    return this.openStream.bind(this)
  }

  // handleIncomingStream handles an incoming stream.
  //
  // this is usually called by the muxer when streams arrive.
  public handleIncomingStream(strm: Stream) {
    const server = this.server
    if (!server) {
      return strm.abort(new Error('server not implemented'))
    }
    server.handlePacketStream(streamToPacketStream(strm))
  }

  // close closes or aborts the muxer with an optional error.
  public close(err?: Error) {
    if (err) {
      this.muxer.abort(err)
    } else {
      this.muxer.close()
    }
  }
}
