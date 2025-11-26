import type { AbortOptions, MessageStreamDirection } from '@libp2p/interface'
import { logger } from '@libp2p/logger'
import {
  AbstractMessageStream,
  type MessageStreamInit,
  type SendResult,
} from '@libp2p/utils'
import type { Duplex, Source } from 'it-stream-types'
import { pushable, type Pushable } from 'it-pushable'
import { Uint8ArrayList } from 'uint8arraylist'

// DuplexMessageStreamInit are parameters for DuplexMessageStream.
export interface DuplexMessageStreamInit {
  // direction is the stream direction.
  direction?: MessageStreamDirection
  // loggerName is the name to use for the logger.
  loggerName?: string
  // inactivityTimeout is the inactivity timeout in ms.
  inactivityTimeout?: number
  // maxReadBufferLength is the max read buffer length.
  maxReadBufferLength?: number
}

// DuplexMessageStream wraps a Duplex stream as a MessageStream.
// This allows using duplex streams with the new libp2p StreamMuxer API.
//
// Extends AbstractMessageStream to get proper read/write buffer management,
// backpressure handling, and event semantics from libp2p.
export class DuplexMessageStream extends AbstractMessageStream {
  // _outgoing is a pushable that collects data to be sent out.
  private readonly _outgoing: Pushable<Uint8Array | Uint8ArrayList>

  constructor(init?: DuplexMessageStreamInit) {
    // Create the MessageStreamInit required by AbstractMessageStream
    const streamInit: MessageStreamInit = {
      log: logger(init?.loggerName ?? 'starpc:duplex-message-stream'),
      direction: init?.direction ?? 'outbound',
      inactivityTimeout: init?.inactivityTimeout,
      maxReadBufferLength: init?.maxReadBufferLength,
    }
    super(streamInit)
    this._outgoing = pushable<Uint8Array | Uint8ArrayList>()
  }

  // source returns an async iterable that yields data to be sent to the remote.
  get source(): AsyncIterable<Uint8Array | Uint8ArrayList> {
    return this._outgoing
  }

  // sink consumes data from the remote and feeds it into the stream.
  // This is the receiving end of the duplex.
  get sink(): (source: Source<Uint8Array | Uint8ArrayList>) => Promise<void> {
    return async (
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
          // Use the parent's onData method which handles buffering and events
          this.onData(data)
        }
        // Remote closed their write side
        this.onRemoteCloseWrite()
      } catch (err) {
        this.abort(err as Error)
      }
    }
  }

  // sendData implements AbstractMessageStream.sendData
  // Called by the parent class when processing the write queue.
  sendData(data: Uint8ArrayList): SendResult {
    // Push data to the outgoing pushable
    this._outgoing.push(data)
    return {
      sentBytes: data.byteLength,
      canSendMore: true, // Our pushable can always accept more
    }
  }

  // sendReset implements AbstractMessageStream.sendReset
  // Called when the stream is aborted locally.
  sendReset(_err: Error): void {
    // End the outgoing pushable - we can't send a reset over a generic duplex
    this._outgoing.end()
  }

  // sendPause implements AbstractMessageStream.sendPause
  // Called when the stream is paused.
  sendPause(): void {
    // No-op: generic duplex streams don't support pause signaling
    this.log.trace('pause requested (no-op for duplex stream)')
  }

  // sendResume implements AbstractMessageStream.sendResume
  // Called when the stream is resumed.
  sendResume(): void {
    // No-op: generic duplex streams don't support resume signaling
    this.log.trace('resume requested (no-op for duplex stream)')
  }

  // close gracefully closes the stream.
  async close(_options?: AbortOptions): Promise<void> {
    if (this.status === 'closed' || this.status === 'closing') {
      return
    }
    this.status = 'closing'
    this.writeStatus = 'closing'

    // End the outgoing pushable to signal we're done writing
    this._outgoing.end()

    this.writeStatus = 'closed'
    if (this.readStatus === 'closed') {
      this.onTransportClosed()
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
