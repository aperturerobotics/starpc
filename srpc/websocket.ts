import { Conn } from './conn'
import { duplex } from 'it-ws'
import { pipe } from 'it-pipe'

// WebSocketConn implements a connection with a WebSocket.
export class WebSocketConn extends Conn {
  // socket is the web socket
  private socket: WebSocket

  constructor(socket: WebSocket) {
    super()
    this.socket = socket
    const socketDuplex = duplex(socket)
    pipe(this.source, socketDuplex, this.sink)
  }

  // getSocket returns the websocket.
  public getSocket(): WebSocket {
    return this.socket
  }
}
