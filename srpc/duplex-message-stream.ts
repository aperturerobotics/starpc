import type {
  AbortOptions,
  Logger,
  MessageStream,
  MessageStreamDirection,
  MessageStreamEvents,
  MessageStreamReadStatus,
  MessageStreamStatus,
  MessageStreamTimeline,
  MessageStreamWriteStatus,
} from '@libp2p/interface'
import {
  StreamAbortEvent,
  StreamCloseEvent,
  StreamMessageEvent,
  TypedEventEmitter,
} from '@libp2p/interface'
import type { Duplex, Source } from 'it-stream-types'
import { pushable, type Pushable } from 'it-pushable'
import { Uint8ArrayList } from 'uint8arraylist'

import { createDisabledLogger } from './log.js'

// DuplexMessageStreamInit are parameters for DuplexMessageStream.
export interface DuplexMessageStreamInit {
  // log is the logger to use.
  log?: Logger
  // direction is the stream direction.
  direction?: MessageStreamDirection
}

// DuplexMessageStream wraps a Duplex stream as a MessageStream.
// This allows using duplex streams with the new libp2p StreamMuxer API.
export class DuplexMessageStream
  extends TypedEventEmitter<MessageStreamEvents>
  implements MessageStream
{
  public status: MessageStreamStatus = 'open'
  public readonly timeline: MessageStreamTimeline = { open: Date.now() }
  public readonly log: Logger
  public direction: MessageStreamDirection
  public maxReadBufferLength: number = 4 * 1024 * 1024 // 4MB
  public maxWriteBufferLength?: number
  public inactivityTimeout: number = 120_000
  public writableNeedsDrain: boolean = false

  private readonly _pushable: Pushable<Uint8Array | Uint8ArrayList>
  private _readStatus: MessageStreamReadStatus = 'readable'
  private _writeStatus: MessageStreamWriteStatus = 'writable'

  // Bound sink function (created once in constructor for efficiency)
  public readonly sink: (
    source: Source<Uint8Array | Uint8ArrayList>,
  ) => Promise<void>

  constructor(init?: DuplexMessageStreamInit) {
    super()
    this.log = init?.log ?? createDisabledLogger('duplex-message-stream')
    this.direction = init?.direction ?? 'outbound'
    this._pushable = pushable<Uint8Array | Uint8ArrayList>()

    // Bind sink once in constructor for efficiency
    this.sink = async (
      source: Source<Uint8Array | Uint8ArrayList>,
    ): Promise<void> => {
      try {
        for await (const data of source) {
          if (
            this.status === 'closed' ||
            this.status === 'aborted' ||
            this.status === 'reset'
          ) {
            break
          }
          this.onData(data)
        }
        this.onRemoteCloseWrite()
      } catch (err) {
        this.abort(err as Error)
      }
    }
  }

  get readBufferLength(): number {
    return 0
  }

  get writeBufferLength(): number {
    return 0
  }

  // source returns an async iterable that yields data to be sent.
  get source(): AsyncIterable<Uint8Array | Uint8ArrayList> {
    return this._pushable
  }

  // onData is called when data is received from the remote.
  private onData(data: Uint8Array | Uint8ArrayList): void {
    if (this._readStatus === 'closed' || this._readStatus === 'closing') {
      return
    }
    this.dispatchEvent(new StreamMessageEvent(data))
  }

  // onRemoteCloseWrite is called when the remote closes its write side.
  private onRemoteCloseWrite(): void {
    if (this.status === 'closed' || this.status === 'closing') {
      return
    }
    this.safeDispatchEvent('remoteCloseWrite')
    if (this._writeStatus === 'closed') {
      this.onTransportClosed()
    }
  }

  // onTransportClosed is called when the underlying transport is closed.
  private onTransportClosed(err?: Error): void {
    if (this.status === 'closed') {
      return
    }
    this.status = 'closed'
    this._readStatus = 'closed'
    this._writeStatus = 'closed'
    this.timeline.close = Date.now()
    if (err) {
      this.dispatchEvent(new StreamAbortEvent(err))
    } else {
      this.dispatchEvent(new StreamCloseEvent())
    }
  }

  // send writes data to the stream.
  send(data: Uint8Array | Uint8ArrayList): boolean {
    if (this._writeStatus === 'closed' || this._writeStatus === 'closing') {
      throw new Error(`Cannot write to a stream that is ${this._writeStatus}`)
    }
    this._pushable.push(data)
    this.safeDispatchEvent('idle')
    return true
  }

  // close gracefully closes the stream.
  async close(_options?: AbortOptions): Promise<void> {
    if (this.status === 'closed' || this.status === 'closing') {
      return
    }
    this.status = 'closing'
    this._writeStatus = 'closing'
    this._pushable.end()
    this._writeStatus = 'closed'
    if (this._readStatus === 'closed') {
      this.onTransportClosed()
    }
  }

  // abort immediately closes the stream with an error.
  abort(err: Error): void {
    if (
      this.status === 'closed' ||
      this.status === 'aborted' ||
      this.status === 'reset'
    ) {
      return
    }
    this.status = 'aborted'
    this._readStatus = 'closed'
    this._writeStatus = 'closed'
    this._pushable.end(err)
    this.timeline.close = Date.now()
    this.dispatchEvent(new StreamAbortEvent(err))
  }

  // pause stops emitting message events.
  pause(): void {
    if (this._readStatus === 'closed' || this._readStatus === 'closing') {
      return
    }
    this._readStatus = 'paused'
  }

  // resume resumes emitting message events.
  resume(): void {
    if (this._readStatus === 'closed' || this._readStatus === 'closing') {
      return
    }
    this._readStatus = 'readable'
  }

  // push queues data to be emitted as a message event.
  push(buf: Uint8Array | Uint8ArrayList): void {
    this.onData(buf)
  }

  // unshift queues data at the front of the read buffer.
  unshift(data: Uint8Array | Uint8ArrayList): void {
    this.onData(data)
  }

  // onDrain returns a promise that resolves when the stream can accept more data.
  async onDrain(_options?: AbortOptions): Promise<void> {
    // Our implementation always accepts data immediately
    return Promise.resolve()
  }

  // AsyncIterable implementation - yields received data
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array | Uint8ArrayList> {
    const output = pushable<Uint8Array | Uint8ArrayList>()
    let ended = false
    const endOutput = () => {
      if (!ended) {
        ended = true
        output.end()
      }
    }
    const onMessage = (evt: Event) => {
      const messageEvt = evt as StreamMessageEvent
      output.push(messageEvt.data)
    }
    const onClose = endOutput
    const onRemoteCloseWrite = endOutput

    this.addEventListener('message', onMessage)
    this.addEventListener('close', onClose)
    this.addEventListener('remoteCloseWrite', onRemoteCloseWrite)
    try {
      yield* output
    } finally {
      this.removeEventListener('message', onMessage)
      this.removeEventListener('close', onClose)
      this.removeEventListener('remoteCloseWrite', onRemoteCloseWrite)
    }
  }
}

// createDuplexMessageStream creates a new DuplexMessageStream.
export function createDuplexMessageStream(
  init?: DuplexMessageStreamInit,
): DuplexMessageStream & Duplex<AsyncIterable<Uint8Array | Uint8ArrayList>> {
  return new DuplexMessageStream(init) as DuplexMessageStream &
    Duplex<AsyncIterable<Uint8Array | Uint8ArrayList>>
}
