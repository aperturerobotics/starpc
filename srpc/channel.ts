import type { Sink, Source, Duplex } from 'it-stream-types'
import { pushable, Pushable } from 'it-pushable'
import { Watchdog } from './watchdog.js'
import { ERR_STREAM_IDLE } from './errors.js'

// ChannelStreamMessage is a message sent over the stream.
export interface ChannelStreamMessage<T> {
  // from indicates who sent the message.
  from: string
  // ack indicates a remote acked establishing the stream.
  ack?: true
  // opened indicates the remote has opened the stream.
  opened?: true
  // closed indicates the stream is closed.
  closed?: true
  // error indicates the stream has an error.
  error?: Error
  // data is any message data.
  data?: T
}

// ChannelPort represents a channel we can open a stream over.
export type ChannelPort =
  | MessagePort
  | { tx: BroadcastChannel; rx: BroadcastChannel }

// ChannelStreamOpts are options for ChannelStream.
export interface ChannelStreamOpts {
  // remoteOpen indicates that the remote already knows the channel is open.
  // this skips sending and waiting for the open+ack messages.
  remoteOpen?: boolean
  // keepAliveMs is the maximum time between sending before we send a keep-alive.
  // if idleTimeoutMs is set on the remote end, this should be less by some margin.
  keepAliveMs?: number
  // idleTimeoutMs is the maximum time between receiving before we close the stream.
  // if keepAliveMs is set on the remote end, this should be more by some margin.
  idleTimeoutMs?: number
}

// ChannelStream implements a Stream over a BroadcastChannel duplex or MessagePort.
//
// NOTE: there is no way to tell if a BroadcastChannel or MessagePort is closed.
// This implementation sends a "closed" message when close() is called.
// However: if the remote is removed w/o closing cleanly, the stream will be left open!
// Enable keepAliveMs and idleTimeoutMs to mitigate this issue with keep-alive messages.
// NOTE: Browsers will throttle setTimeout in background tabs.
export class ChannelStream<T = Uint8Array> implements Duplex<
  AsyncGenerator<T>,
  Source<T>,
  Promise<void>
> {
  // channel is the read/write channel.
  public readonly channel: ChannelPort
  // sink is the sink for incoming messages.
  public sink: Sink<Source<T>, Promise<void>>
  // source is the source for outgoing messages.
  public source: AsyncGenerator<T>
  // _source emits incoming data to the source.
  private readonly _source: {
    push: (val: T) => void
    end: (err?: Error) => void
  }
  // localId is the local identifier
  private readonly localId: string
  // localOpen indicates the local side has opened the stream.
  private localOpen: boolean
  // remoteOpen indicates the remote side has opened the stream.
  private remoteOpen: boolean
  // waitRemoteOpen indicates the remote side has opened the stream.
  public readonly waitRemoteOpen: Promise<void>
  // _remoteOpen fulfills the waitRemoteOpen promise.
  private _remoteOpen?: (err?: Error) => void
  // remoteAck indicates the remote side has acked the stream.
  private remoteAck: boolean
  // waitRemoteAck indicates the remote side has opened the stream.
  public readonly waitRemoteAck: Promise<void>
  // _remoteAck fulfills the waitRemoteAck promise.
  private _remoteAck?: (err?: Error) => void
  // keepAliveWatchdog is the transmission timeout watchdog.
  private keepAlive?: Watchdog
  // idleWatchdog is the receive timeout watchdog.
  private idleWatchdog?: Watchdog

  // isAcked checks if the stream is acknowledged by the remote.
  public get isAcked() {
    return this.remoteAck ?? false
  }

  // isOpen checks if the stream is opened by the remote.
  public get isOpen() {
    return this.remoteOpen ?? false
  }

  // isIdlePaused checks if the idle watchdog is paused.
  public get isIdlePaused() {
    return this.idleWatchdog?.isPaused ?? false
  }

  constructor(localId: string, channel: ChannelPort, opts?: ChannelStreamOpts) {
    // initial state
    this.localId = localId
    this.channel = channel
    this.localOpen = false
    this.remoteOpen = opts?.remoteOpen ?? false
    this.remoteAck = this.remoteOpen

    // wire up the promises for remote ack and remote open
    if (this.remoteOpen) {
      this.waitRemoteOpen = Promise.resolve()
      this.waitRemoteAck = Promise.resolve()
    } else {
      this.waitRemoteOpen = new Promise<void>((resolve, reject) => {
        this._remoteOpen = (err?: Error) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
      })
      this.waitRemoteOpen.catch(() => {})
      this.waitRemoteAck = new Promise<void>((resolve, reject) => {
        this._remoteAck = (err?: Error) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
      })
      this.waitRemoteAck.catch(() => {})
    }

    // create the sink
    this.sink = this._createSink()

    // create the pushable source
    const source: Pushable<T> = pushable({ objectMode: true })
    this.source = source
    this._source = source

    // wire up the message handlers
    const onMessage = this.onMessage.bind(this)
    if (channel instanceof MessagePort) {
      // MessagePort
      channel.onmessage = onMessage
      channel.start()
    } else {
      // BroadcastChannel
      channel.rx.onmessage = onMessage
    }

    // handle the keep alive or idle timeout opts
    if (opts?.idleTimeoutMs != null) {
      this.idleWatchdog = new Watchdog(opts.idleTimeoutMs, () =>
        this.idleElapsed(),
      )
    }
    if (opts?.keepAliveMs != null) {
      this.keepAlive = new Watchdog(opts.keepAliveMs, () =>
        this.keepAliveElapsed(),
      )
    }

    // broadcast ack to start the stream
    this.postMessage({ ack: true })
  }

  // postMessage writes a message to the stream.
  private postMessage(msg: Partial<ChannelStreamMessage<T>>) {
    msg.from = this.localId
    if (this.channel instanceof MessagePort) {
      this.channel.postMessage(msg)
    } else {
      this.channel.tx.postMessage(msg)
    }
    if (!msg.closed) {
      this.keepAlive?.feed()
    }
  }

  // idleElapsed is called if the idle timeout was elapsed.
  private idleElapsed() {
    if (this.idleWatchdog) {
      delete this.idleWatchdog
      this.close(new Error(ERR_STREAM_IDLE))
    }
  }

  // keepAliveElapsed is called if the keep alive timeout was elapsed.
  private keepAliveElapsed() {
    if (this.keepAlive) {
      // send a keep-alive message
      this.postMessage({})
    }
  }

  // close closes the broadcast channels.
  public close(error?: Error) {
    // write a message to indicate the stream is now closed.
    this.postMessage({ closed: true, error })
    // close channels
    if (this.channel instanceof MessagePort) {
      this.channel.close()
    } else {
      this.channel.tx.close()
      this.channel.rx.close()
    }
    if (!this.remoteOpen && this._remoteOpen) {
      this._remoteOpen(error || new Error('closed'))
    }
    if (!this.remoteAck && this._remoteAck) {
      this._remoteAck(error || new Error('closed'))
    }
    if (this.idleWatchdog) {
      this.idleWatchdog.clear()
      delete this.idleWatchdog
    }
    if (this.keepAlive) {
      this.keepAlive.clear()
      delete this.keepAlive
    }
    this._source.end(error)
  }

  // pauseIdle pauses the idle watchdog, preventing the stream from timing out.
  // Use this when the remote is known to be inactive (e.g., browser tab hidden).
  public pauseIdle() {
    this.idleWatchdog?.pause()
  }

  // resumeIdle resumes the idle watchdog after being paused.
  // The timeout continues from where it left off.
  public resumeIdle() {
    this.idleWatchdog?.resume()
  }

  // onLocalOpened indicates the local side has opened the read stream.
  private onLocalOpened() {
    if (!this.localOpen) {
      this.localOpen = true
      this.postMessage({ opened: true })
    }
  }

  // onRemoteAcked indicates the remote side has acked the stream.
  private onRemoteAcked() {
    if (!this.remoteAck) {
      this.remoteAck = true
      if (this._remoteAck) {
        this._remoteAck()
      }
    }
  }

  // onRemoteOpened indicates the remote side has opened the read stream.
  private onRemoteOpened() {
    if (!this.remoteOpen) {
      this.remoteOpen = true
      if (this._remoteOpen) {
        this._remoteOpen()
      }
    }
  }

  private _createSink(): Sink<Source<T>, Promise<void>> {
    return async (source: Source<T>) => {
      // make sure the remote is open before we send any data.
      await this.waitRemoteAck
      this.onLocalOpened()
      await this.waitRemoteOpen

      try {
        for await (const msg of source) {
          this.postMessage({ data: msg })
        }
        this.postMessage({ closed: true })
      } catch (error) {
        this.postMessage({ closed: true, error: error as Error })
      }
    }
  }

  private onMessage(ev: MessageEvent<ChannelStreamMessage<T>>) {
    const msg = ev.data
    if (!msg || msg.from === this.localId || !msg.from) {
      return
    }
    this.idleWatchdog?.feed()
    if (msg.ack || msg.opened) {
      this.onRemoteAcked()
    }
    if (msg.opened) {
      this.onRemoteOpened()
    }
    const { data, closed, error: err } = msg
    if (data) {
      this._source.push(data)
    }
    if (err) {
      this._source.end(err)
    } else if (closed) {
      this._source.end()
    }
  }
}

// newBroadcastChannelStream constructs a ChannelStream with a channel name.
export function newBroadcastChannelStream<T>(
  id: string,
  readName: string,
  writeName: string,
  opts?: ChannelStreamOpts,
): ChannelStream<T> {
  return new ChannelStream<T>(
    id,
    { tx: new BroadcastChannel(writeName), rx: new BroadcastChannel(readName) },
    opts,
  )
}
