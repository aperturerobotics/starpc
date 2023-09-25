import type { Sink, Source } from 'it-stream-types'
import { EventIterator } from 'event-iterator'

import { ConnParams } from './conn.js'
import { Server } from './server'
import { Stream } from './stream.js'
import { StreamConn } from './conn-stream.js'

// MessagePortDuplex is a AsyncIterable wrapper for MessagePort.
export class MessagePortDuplex<T> implements Stream<T> {
  // port is the message port
  public readonly port: MessagePort
  // sink is the sink for incoming messages.
  public sink: (source: Source<T>) => Promise<void>
  // source is the source for outgoing messages.
  public source: AsyncGenerator<T>

  constructor(port: MessagePort) {
    this.port = port
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // close closes the message port.
  public close() {
    this.port.close()
  }

  // _createSink initializes the sink field.
  private _createSink(): (source: Source<T>) => Promise<void> {
    return async (source) => {
      for await (const msg of source) {
        this.port.postMessage(msg)
      }
    }
  }

  // _createSource initializes the source field.
  private async *_createSource(): AsyncGenerator<T> {
    const iterator = new EventIterator<T>((queue) => {
      const messageListener = (ev: MessageEvent<T>) => {
        if (ev.data) {
          queue.push(ev.data)
        }
      }

      this.port.addEventListener('message', messageListener)
      return () => {
        this.port.removeEventListener('message', messageListener)
      }
    })

    for await (const value of iterator) {
      yield value
    }
  }
}

// newMessagePortDuplex constructs a MessagePortDuplex with a channel name.
export function newMessagePortDuplex<T>(
  port: MessagePort,
): MessagePortDuplex<T> {
  return new MessagePortDuplex<T>(port)
}

// MessagePortConn implements a connection with a MessagePort.
//
// expects Uint8Array objects over the MessagePort.
export class MessagePortConn extends StreamConn {
  // messagePort is the message port iterable.
  private messagePort: MessagePortDuplex<Uint8Array>

  constructor(port: MessagePort, server?: Server, connParams?: ConnParams) {
    const messagePort = new MessagePortDuplex<Uint8Array>(port)
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
