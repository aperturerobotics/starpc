import type { Duplex, Source } from 'it-stream-types'
import { EventIterator } from 'event-iterator'

import { StreamConn, StreamConnParams } from './conn.js'
import { Server } from './server.js'
import { combineUint8ArrayListTransform } from './array-list.js'
import { pipe } from 'it-pipe'

// BroadcastChannelDuplex is a AsyncIterable wrapper for BroadcastChannel.
//
// When the sink is closed, the broadcast channel also be closed.
// Note: there is no way to know when a BroadcastChannel is closed!
// You will need an additional keep-alive on top of BroadcastChannelDuplex.
export class BroadcastChannelDuplex<T> implements Duplex<
  AsyncGenerator<T>,
  Source<T>,
  Promise<void>
> {
  // read is the read channel
  public readonly read: BroadcastChannel
  // write is the write channel
  public readonly write: BroadcastChannel
  // sink is the sink for incoming messages.
  public sink: (source: Source<T>) => Promise<void>
  // source is the source for outgoing messages.
  public source: AsyncGenerator<T>

  constructor(read: BroadcastChannel, write: BroadcastChannel) {
    this.read = read
    this.write = write
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // close closes the message port.
  public close() {
    this.write.postMessage(null)
    this.write.close()
    this.read.close()
  }

  // _createSink initializes the sink field.
  private _createSink(): (source: Source<T>) => Promise<void> {
    return async (source) => {
      try {
        for await (const msg of source) {
          this.write.postMessage(msg)
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

      this.read.addEventListener('message', messageListener)
      return () => {
        this.read.removeEventListener('message', messageListener)
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

// newBroadcastChannelDuplex constructs a BroadcastChannelDuplex with a channel name.
export function newBroadcastChannelDuplex<T>(
  readName: string,
  writeName: string,
): BroadcastChannelDuplex<T> {
  return new BroadcastChannelDuplex<T>(
    new BroadcastChannel(readName),
    new BroadcastChannel(writeName),
  )
}

// BroadcastChannelConn implements a connection with a BroadcastChannel.
//
// expects Uint8Array objects over the BroadcastChannel.
// uses Yamux to mux streams over the port.
export class BroadcastChannelConn extends StreamConn {
  // duplex is the broadcast channel duplex.
  public readonly duplex: BroadcastChannelDuplex<Uint8Array>

  constructor(
    duplex: BroadcastChannelDuplex<Uint8Array>,
    server?: Server,
    connParams?: StreamConnParams,
  ) {
    super(server, {
      ...connParams,
      yamuxParams: {
        // There is no way to tell when a BroadcastChannel is closed.
        // We will send an undefined object through the BroadcastChannel to indicate closed.
        // We still need a way to detect when the connection is not cleanly terminated.
        // Enable keep-alive to detect this on the other end.
        enableKeepAlive: true,
        keepAliveInterval: 1500,
        ...connParams?.yamuxParams,
      },
    })
    this.duplex = duplex
    pipe(
      duplex,
      this,
      // Uint8ArrayList usually cannot be sent over BroadcastChannel, so we combine to a Uint8Array as part of the pipe.
      combineUint8ArrayListTransform(),
      duplex,
    )
      .catch((err) => this.close(err))
      .then(() => this.close())
  }

  // close closes the message port.
  public override close(err?: Error) {
    super.close(err)
    this.duplex.close()
  }
}
