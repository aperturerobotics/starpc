import net from 'net'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import type { Source } from 'it-stream-types'

import { combineUint8ArrayListTransform } from '../../srpc/array-list.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from '../../srpc/packet.js'
import type { PacketStream } from '../../srpc/stream.js'
import {
  closeIterator,
  sourceIterator,
  TerminationGate,
} from '../../srpc/termination.js'

// tcpSocketToPacketStream wraps a Node.js TCP socket into a PacketStream.
export function tcpSocketToPacketStream(socket: net.Socket): PacketStream {
  const sourceTermination = new TerminationGate()
  const sinkTermination = new TerminationGate()
  const bytes = pushable<Uint8Array>({ objectMode: true })
  let bytesEnded = false

  const endBytes = (error?: Error) => {
    if (bytesEnded) return
    bytesEnded = true
    bytes.end(error)
  }
  const terminate = (error?: Error): boolean => {
    const first = sourceTermination.terminate(error)
    sinkTermination.terminate(error)
    endBytes(error)
    return first
  }

  socket.on('data', (data: Buffer) => {
    if (!bytesEnded) bytes.push(new Uint8Array(data))
  })
  socket.on('end', () => endBytes())
  socket.on('error', (error) => terminate(error))
  socket.on('close', () => {
    endBytes()
    sinkTermination.terminate()
  })

  const close = async (): Promise<void> => {
    if (terminate()) socket.destroy()
  }
  const abort = (error: Error): void => {
    if (terminate(error)) socket.destroy(error)
  }

  return {
    close,
    abort,
    source: (async function* () {
      const packets = pipe(
        bytes,
        parseLengthPrefixTransform(),
        combineUint8ArrayListTransform(),
      )[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await sourceTermination.next(packets)
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
      try {
        while (true) {
          const next = await sinkTermination.next(iterator)
          if ('terminated' in next) {
            if (next.error) throw next.error
            return
          }
          if ('error' in next) throw next.error
          if (next.result.done) {
            socket.end()
            return
          }
          const data =
            next.result.value instanceof Uint8Array
              ? next.result.value
              : next.result.value.subarray()
          const written = await sinkTermination.wait(
            new Promise<void>((resolve, reject) => {
              socket.write(data, (error) => {
                if (error) reject(error)
                else resolve()
              })
            }),
          )
          if ('terminated' in written) {
            if (written.error) throw written.error
            return
          }
          if ('error' in written) throw written.error
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        abort(error)
        throw error
      } finally {
        closeIterator(iterator)
      }
    },
  }
}
