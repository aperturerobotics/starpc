import type { Duplex, Sink } from 'it-stream-types'
import { EventIterator } from 'event-iterator'

import { ConnParams } from './conn.js'
import { DuplexConn } from './conn-duplex.js'
import { Server } from './server'

// MessagePortIterable is a AsyncIterable wrapper for MessagePort.
export class MessagePortIterable<T> implements Duplex<T> {
  // port is the message port
  public readonly port: MessagePort
  // sink is the sink for incoming messages.
  public sink: Sink<T>
  // source is the source for outgoing messages.
  public source: AsyncIterable<T>
  // _source is the EventIterator for source.
  private _source: EventIterator<T>

  constructor(port: MessagePort) {
    this.port = port
    this.sink = this._createSink()
    this._source = this._createSource()
    this.source = this._source
  }

  // close closes the message port.
  public close() {
    this.port.close()
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<T> {
    return async (source) => {
      for await (const msg of source) {
        this.port.postMessage(msg)
      }
    }
  }

  // _createSource initializes the source field.
  private _createSource() {
    return new EventIterator<T>((queue) => {
      const messageListener = (ev: MessageEvent<T>) => {
        if (ev.data) {
          queue.push(ev.data)
        }
      }

      this.port.addEventListener('message', messageListener)
      this.port.start()
      return () => {
        this.port.removeEventListener('message', messageListener)
      }
    })
  }
}

// newMessagePortIterable constructs a MessagePortIterable with a channel name.
export function newMessagePortIterable<T>(
  port: MessagePort
): MessagePortIterable<T> {
  return new MessagePortIterable<T>(port)
}

// MessagePortConn implements a connection with a MessagePort.
//
// expects Uint8Array objects over the MessagePort.
export class MessagePortConn extends DuplexConn {
  // messagePort is the message port iterable.
  private messagePort: MessagePortIterable<Uint8Array>

  constructor(port: MessagePort, server?: Server, connParams?: ConnParams) {
    const messagePort = new MessagePortIterable<Uint8Array>(port)
    super(messagePort, server, connParams)
    this.messagePort = messagePort
  }

  // getMessagePort returns the MessagePort.
  public getMessagePort(): MessagePort {
    return this.messagePort.port
  }

  // close closes the message port.
  public close() {
    this.messagePort.close()
  }
}
