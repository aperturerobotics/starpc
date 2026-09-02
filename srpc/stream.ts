import type { Duplex, Source } from 'it-stream-types'
import { pipe } from 'it-pipe'

import type { Stream } from './stream-muxer.js'
import type { Packet } from './rpcproto.pb.js'
import { combineUint8ArrayListTransform } from './array-list.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet.js'
import {
  closeIterator,
  sourceIterator,
  TerminationGate,
} from './termination.js'

// PacketHandler handles incoming packets.
export type PacketHandler = (packet: Packet) => Promise<void>

// PacketStream represents a stream of packets where each Uint8Array represents one packet.
export interface PacketStream extends Duplex<
  AsyncGenerator<Uint8Array>,
  Source<Uint8Array>,
  Promise<void>
> {
  // close cleanly ends both directions of the stream.
  close(): Promise<void>
  // abort ends both directions of the stream with err.
  abort(err: Error): void
}

// OpenStreamFunc is a function to start a new RPC by opening a Stream.
export type OpenStreamFunc = () => Promise<PacketStream>

// HandleStreamFunc handles an incoming RPC stream.
// Returns as soon as the stream has been passed off to be handled.
// Throws an error if we can't handle the incoming stream.
export type HandleStreamFunc = (ch: PacketStream) => Promise<void>

// streamToPacketStream converts a Stream into a PacketStream using length-prefix framing.
export function streamToPacketStream(stream: Stream): PacketStream {
  const termination = new TerminationGate()
  return {
    close: async () => {
      if (termination.terminate()) await stream.close()
    },
    abort: (err: Error) => {
      if (termination.terminate(err)) stream.abort(err)
    },
    source: (async function* () {
      const packets = pipe(
        stream,
        parseLengthPrefixTransform(),
        combineUint8ArrayListTransform(),
      )[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await termination.next(packets)
          if ('terminated' in next) {
            if (next.error) throw next.error
            return
          }
          if ('error' in next) throw next.error
          if (next.result.done) return
          yield next.result.value
        }
      } finally {
        closeIterator(packets)
      }
    })(),
    sink: async (source: Source<Uint8Array>): Promise<void> => {
      const iterator = sourceIterator(
        pipe(source, prependLengthPrefixTransform()),
      )
      const gatedSource = (async function* () {
        while (true) {
          const next = await termination.next(iterator)
          if ('terminated' in next) {
            if (next.error) throw next.error
            return
          }
          if ('error' in next) throw next.error
          if (next.result.done) return
          if (termination.terminated) return
          yield next.result.value
        }
      })()
      try {
        const result = await termination.wait(stream.sink(gatedSource))
        if ('terminated' in result) {
          if (result.error) throw result.error
          return
        }
        if ('error' in result) throw result.error
        await stream.closeWrite()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (termination.terminate(error)) stream.abort(error)
        throw error
      } finally {
        closeIterator(iterator)
      }
    },
  }
}
