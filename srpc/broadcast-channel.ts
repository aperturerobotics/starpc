import type { Duplex, Sink } from 'it-stream-types'
import { EventIterator } from 'event-iterator'

import { ConnParams } from './conn.js'
import { Server } from './server.js'
import { DuplexConn } from './conn-duplex.js'

// BroadcastChannelDuplex is a AsyncIterable wrapper for BroadcastChannel.
export class BroadcastChannelDuplex<T> implements Duplex<T> {
  // readChannel is the incoming broadcast channel
  public readonly readChannel: BroadcastChannel
  // writeChannel is the outgoing broadcast channel
  public readonly writeChannel: BroadcastChannel
  // sink is the sink for incoming messages.
  public sink: Sink<T>
  // source is the source for outgoing messages.
  public source: AsyncIterable<T>

  constructor(readChannel: BroadcastChannel, writeChannel: BroadcastChannel) {
    this.readChannel = readChannel
    this.writeChannel = writeChannel
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // close closes the broadcast channels.
  public close() {
    this.readChannel.close()
    this.writeChannel.close()
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<T> {
    return async (source) => {
      for await (const msg of source) {
        this.writeChannel.postMessage(msg)
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

      this.readChannel.addEventListener('message', messageListener)
      return () => {
        this.readChannel.removeEventListener('message', messageListener)
      }
    })
  }
}

// newBroadcastChannelDuplex constructs a BroadcastChannelDuplex with a channel name.
export function newBroadcastChannelDuplex<T>(
  readName: string,
  writeName: string
): BroadcastChannelDuplex<T> {
  return new BroadcastChannelDuplex<T>(
    new BroadcastChannel(readName),
    new BroadcastChannel(writeName)
  )
}

// BroadcastChannelConn implements a connection with a BroadcastChannel.
//
// expects Uint8Array objects over the BroadcastChannel.
export class BroadcastChannelConn extends DuplexConn {
  // broadcastChannel is the broadcast channel iterable
  private broadcastChannel: BroadcastChannelDuplex<Uint8Array>

  constructor(
    readChannel: BroadcastChannel,
    writeChannel: BroadcastChannel,
    server?: Server,
    connParams?: ConnParams
  ) {
    const broadcastChannel = new BroadcastChannelDuplex<Uint8Array>(
      readChannel,
      writeChannel
    )
    super(broadcastChannel, server, connParams)
    this.broadcastChannel = broadcastChannel
  }

  // getReadChannel returns the read BroadcastChannel.
  public getReadChannel(): BroadcastChannel {
    return this.broadcastChannel.readChannel
  }

  // getWriteChannel returns the write BroadcastChannel.
  public getWriteChannel(): BroadcastChannel {
    return this.broadcastChannel.writeChannel
  }

  // close closes the read and write channels.
  public close() {
    this.broadcastChannel.close()
  }
}
