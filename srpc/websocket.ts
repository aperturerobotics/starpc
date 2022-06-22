import { duplex } from 'it-ws'
import { pipe } from 'it-pipe'
import { Mplex } from '@libp2p/mplex'
import type WebSocket from 'isomorphic-ws'

import { Conn } from './conn.js'
import { Server } from './server.js'

// WebSocketConn implements a connection with a WebSocket and optional Server.
export class WebSocketConn extends Conn {
  // socket is the web socket
  private socket: WebSocket

  constructor(socket: WebSocket, server?: Server) {
    super(server, {
      muxerFactory: new Mplex(),
    })
    this.socket = socket
    const socketDuplex = duplex(socket)
    pipe(socketDuplex, this, socketDuplex)
  }

  // getSocket returns the websocket.
  public getSocket(): WebSocket {
    return this.socket
  }
}
