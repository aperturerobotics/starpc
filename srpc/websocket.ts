import { Conn } from './conn.js'
import { duplex } from 'it-ws'
import { pipe } from 'it-pipe'
import { Mplex } from '@libp2p/mplex'
import type WebSocket from 'isomorphic-ws'

// WebSocketConn implements a connection with a WebSocket.
export class WebSocketConn extends Conn {
  // socket is the web socket
  private socket: WebSocket

  constructor(socket: WebSocket) {
    super({
      muxerFactory: new Mplex(),
    })
    this.socket = socket
    const socketDuplex = duplex(socket)
    pipe(this.source, socketDuplex, this.sink)
  }

  // getSocket returns the websocket.
  public getSocket(): WebSocket {
    return this.socket
  }
}
