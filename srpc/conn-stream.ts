import { pipe } from 'it-pipe'

import { Conn, ConnParams } from './conn.js'
import { Server } from './server'
import { Stream } from './stream.js'

// StreamConn wraps any Stream into a Conn.
//
// expects Uint8Array objects
export class StreamConn extends Conn {
  // channel is the iterable
  private channel: Stream

  constructor(duplex: Stream, server?: Server, connParams?: ConnParams) {
    super(server, connParams)
    this.channel = duplex
    pipe(this.channel, this, this.channel)
  }

  // getChannelStream returns the Duplex channel.
  public getChannelStream(): Stream {
    return this.channel
  }
}
