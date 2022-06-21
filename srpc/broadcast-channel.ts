import type { Duplex, Sink } from 'it-stream-types'
import { Conn, ConnParams } from './conn'
import { EventIterator } from 'event-iterator'
import { pipe } from 'it-pipe'
import { Server } from './server'

// BroadcastChannelIterable is a AsyncIterable wrapper for BroadcastChannel.
export class BroadcastChannelIterable<T> implements Duplex<T> {
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

// newBroadcastChannelIterable constructs a BroadcastChannelIterable with a channel name.
export function newBroadcastChannelIterable<T>(
  readName: string,
  writeName: string
): BroadcastChannelIterable<T> {
  return new BroadcastChannelIterable<T>(
    new BroadcastChannel(readName),
    new BroadcastChannel(writeName)
  )
}

// BroadcastChannelConn implements a connection with a BroadcastChannel.
//
// expects Uint8Array objects over the BroadcastChannel.
export class BroadcastChannelConn extends Conn {
  // channel is the broadcast channel iterable
  private channel: BroadcastChannelIterable<Uint8Array>

  constructor(
    readChannel: BroadcastChannel,
    writeChannel: BroadcastChannel,
    server?: Server,
    connParams?: ConnParams
  ) {
    super(server, connParams)
    this.channel = new BroadcastChannelIterable<Uint8Array>(
      readChannel,
      writeChannel
    )
    pipe(this, this.channel, this)
  }

  // getReadChannel returns the read BroadcastChannel.
  public getReadChannel(): BroadcastChannel {
    return this.channel.readChannel
  }

  // getWriteChannel returns the write BroadcastChannel.
  public getWriteChannel(): BroadcastChannel {
    return this.channel.writeChannel
  }
}
