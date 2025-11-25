import { pipe } from 'it-pipe'
import type { MessageStreamDirection } from '@libp2p/interface'

import duplex from '@aptre/it-ws/duplex'
import type WebSocket from '@aptre/it-ws/web-socket'

import { StreamConn } from './conn.js'
import { Server } from './server.js'
import { combineUint8ArrayListTransform } from './array-list.js'

// WebSocketConn implements a connection with a WebSocket and optional Server.
export class WebSocketConn extends StreamConn {
  // socket is the web socket
  private socket: WebSocket

  constructor(
    socket: WebSocket,
    direction: MessageStreamDirection,
    server?: Server,
  ) {
    super(server, { direction })
    this.socket = socket
    const socketDuplex = duplex(socket)
    pipe(
      socketDuplex,
      this,
      // it-ws only supports sending Uint8Array.
      combineUint8ArrayListTransform(),
      socketDuplex,
    )
      .catch((err) => this.close(err))
      .then(() => this.close())
  }

  // getSocket returns the websocket.
  public getSocket(): WebSocket {
    return this.socket
  }
}
