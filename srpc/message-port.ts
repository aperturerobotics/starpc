import type { Duplex, Source } from 'it-stream-types'
import { EventIterator } from 'event-iterator'
import { pipe } from 'it-pipe'

import { StreamConn, StreamConnParams } from './conn.js'
import { Server } from './server.js'
import { combineUint8ArrayListTransform } from './array-list.js'

// MessagePortDuplex is a AsyncIterable wrapper for MessagePort.
//
// When the sink is closed, the message port will also be closed.
// null will be written through the channel to indicate closure when the sink is closed.
// Note: there is no way to know for sure when a MessagePort is closed!
// You will need an additional keep-alive on top of MessagePortDuplex.
export class MessagePortDuplex<
  T extends NonNullable<unknown>,
> implements Duplex<AsyncGenerator<T>, Source<T>, Promise<void>> {
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
    this.port.postMessage(null)
    this.port.close()
  }

  // _createSink initializes the sink field.
  private _createSink(): (source: Source<T>) => Promise<void> {
    return async (source) => {
      try {
        for await (const msg of source) {
          this.port.postMessage(msg)
        }
      } catch (err: unknown) {
        this.close()
        throw err
      }

      this.close()
    }
  }

  // _createSource initializes the source field.
  private async *_createSource(): AsyncGenerator<T> {
    const iterator = new EventIterator<T>((queue) => {
      const messageListener = (ev: MessageEvent<T | null>) => {
        const data = ev.data
        if (data !== null) {
          queue.push(data)
        } else {
          queue.stop()
        }
      }

      this.port.addEventListener('message', messageListener)
      this.port.start()

      return () => {
        this.port.removeEventListener('message', messageListener)
      }
    })

    try {
      for await (const value of iterator) {
        yield value
      }
    } catch (err) {
      this.close()
      throw err
    }

    this.close()
  }
}

// newMessagePortDuplex constructs a MessagePortDuplex with a channel name.
export function newMessagePortDuplex<T extends NonNullable<unknown>>(
  port: MessagePort,
): MessagePortDuplex<T> {
  return new MessagePortDuplex<T>(port)
}

// MessagePortConn implements a connection with a MessagePort.
//
// expects Uint8Array objects over the MessagePort.
// uses Yamux to mux streams over the port.
export class MessagePortConn extends StreamConn {
  // _messagePort is the message port iterable.
  private _messagePort: MessagePortDuplex<Uint8Array>

  constructor(
    port: MessagePort,
    server?: Server,
    connParams?: StreamConnParams,
  ) {
    const messagePort = new MessagePortDuplex<Uint8Array>(port)
    super(server, {
      ...connParams,
      yamuxParams: {
        // There is no way to tell when a MessagePort is closed.
        // We will send an undefined object through the MessagePort to indicate closed.
        // We still need a way to detect when the connection is not cleanly terminated.
        // Enable keep-alive to detect this on the other end.
        enableKeepAlive: true,
        keepAliveInterval: 1500,
        ...connParams?.yamuxParams,
      },
    })
    this._messagePort = messagePort
    pipe(
      messagePort,
      this,
      // Uint8ArrayList usually cannot be sent over MessagePort, so we combine to a Uint8Array as part of the pipe.
      combineUint8ArrayListTransform(),
      messagePort,
    )
      .catch((err) => this.close(err))
      .then(() => this.close())
  }

  // messagePort returns the MessagePort.
  get messagePort(): MessagePort {
    return this._messagePort.port
  }

  // close closes the message port.
  public override close(err?: Error) {
    super.close(err)
    this.messagePort.close()
  }
}
