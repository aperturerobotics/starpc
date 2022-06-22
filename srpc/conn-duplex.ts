import { pipe } from 'it-pipe'
import type { Duplex } from 'it-stream-types'

import { Conn, ConnParams } from './conn.js'
import { Server } from './server'

// DuplexConn wraps any Duplex<Uint8Array> into a Conn.
//
// expects Uint8Array objects
export class DuplexConn extends Conn {
  // channel is the iterable
  private channel: Duplex<Uint8Array>

  constructor(
    duplex: Duplex<Uint8Array>,
    server?: Server,
    connParams?: ConnParams
  ) {
    super(server, connParams)
    this.channel = duplex
    pipe(this, this.channel, this)
  }

  // getChannelDuplex returns the Duplex channel.
  public getChannelDuplex(): Duplex<Uint8Array> {
    return this.channel
  }
}
