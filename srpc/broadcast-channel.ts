import type { Duplex, Sink } from 'it-stream-types'
import { Conn } from './conn'
import { EventIterator } from 'event-iterator'
import { pipe } from 'it-pipe'

// BroadcastChannelIterable is a AsyncIterable wrapper for BroadcastChannel.
export class BroadcastChannelIterable<T> implements Duplex<T> {
  // channel is the broadcast channel
  public readonly channel: BroadcastChannel
  // sink is the sink for incoming messages.
  public sink: Sink<T>
  // source is the source for outgoing messages.
  public source: AsyncIterable<T>

  constructor(channel: BroadcastChannel) {
    this.channel = channel
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<T> {
    return async (source) => {
      for await (const msg of source) {
        this.channel.postMessage(msg)
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
      this.channel.addEventListener('message', messageListener)

      return () => {
        this.channel.removeEventListener('message', messageListener)
      }
    })
  }
}

// newBroadcastChannelIterable constructs a BroadcastChannelIterable with a channel name.
export function newBroadcastChannelIterable<T>(
  name: string
): BroadcastChannelIterable<T> {
  const channel = new BroadcastChannel(name)
  return new BroadcastChannelIterable<T>(channel)
}

// BroadcastChannelConn implements a connection with a BroadcastChannel.
//
// expects Uint8Array objects over the BroadcastChannel.
export class BroadcastChannelConn extends Conn {
  // channel is the broadcast channel iterable
  private channel: BroadcastChannelIterable<Uint8Array>

  constructor(channel: BroadcastChannel) {
    super()
    this.channel = new BroadcastChannelIterable<Uint8Array>(channel)
    pipe(this, this.channel, this)
  }

  // getBroadcastChannel returns the BroadcastChannel.
  public getBroadcastChannel(): BroadcastChannel {
    return this.channel.channel
  }
}
