import { describe, expect, it, vi } from 'vitest'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import type { Source } from 'it-stream-types'
import type { Stream } from './stream-muxer.js'
import { streamToPacketStream } from './stream.js'

import {
  ChannelStream,
  combineUint8ArrayListTransform,
  StreamConn,
  type ChannelStreamOpts,
  type PacketStream,
  type StreamHandler,
} from '../srpc/index.js'

describe('StreamConn packet stream', () => {
  it('keeps yamux peer writes open after local packet source completes normally', async () => {
    const request = new TextEncoder().encode('request')
    const response = new TextEncoder().encode('response')

    let serverError: unknown
    const serverDone = new Promise<void>((resolve, reject) => {
      const { clientConn, cleanup } = connectStreamConns({
        handlePacketStream(stream: PacketStream) {
          void (async () => {
            const packets = stream.source[Symbol.asyncIterator]()
            const first = await nextWithTimeout(
              packets,
              'server request packet',
            )
            expect(first.done).toBe(false)
            expect([...first.value]).toEqual([...request])

            const done = await nextWithTimeout(packets, 'server request eof')
            expect(done.done).toBe(true)

            await stream.sink(
              (async function* () {
                yield response
              })(),
            )
          })()
            .then(resolve)
            .catch((err) => {
              serverError = err
              reject(err)
            })
        },
      })

      void (async () => {
        try {
          const clientStream = await clientConn.openStream()
          await clientStream.sink(
            (async function* () {
              yield request
            })(),
          )

          const packets = clientStream.source[Symbol.asyncIterator]()
          const first = await nextWithTimeout(packets, 'client response packet')
          expect(first.done).toBe(false)
          expect([...first.value]).toEqual([...response])

          const done = await nextWithTimeout(packets, 'client response eof')
          expect(done.done).toBe(true)
        } finally {
          cleanup()
        }
      })().catch(reject)
    })

    await serverDone
    expect(serverError).toBeUndefined()
  })

  it('settles a blocked packet source when closed', async () => {
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream() {},
    })

    try {
      const stream = await clientConn.openStream()
      const pending = stream.source.next()

      await stream.close()

      await expect(pending).resolves.toEqual({ done: true, value: undefined })
    } finally {
      cleanup()
    }
  })

  it('settles a blocked packet source when aborted', async () => {
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream() {},
    })

    try {
      const stream = await clientConn.openStream()
      const pending = stream.source.next()
      const error = new Error('stopped')

      stream.abort(error)

      await expect(pending).rejects.toBe(error)
    } finally {
      cleanup()
    }
  })

  it('settles a blocked packet sink when closed', async () => {
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream() {},
    })

    try {
      const stream = await clientConn.openStream()
      const input = pushable<Uint8Array>({ objectMode: true })
      const pending = stream.sink(input)

      await stream.close()

      await expect(pending).resolves.toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('settles a packet sink blocked in the underlying write', async () => {
    const sinkStarted = Promise.withResolvers<void>()
    const transport = {
      source: (async function* () {})(),
      sink: async (source: Source<Uint8Array>) => {
        for await (const _chunk of source) {
          sinkStarted.resolve()
          await new Promise<void>(() => {})
        }
      },
      close: vi.fn(async () => {}),
      closeRead: vi.fn(async () => {}),
      closeWrite: vi.fn(async () => {}),
      abort: vi.fn(),
    } satisfies Stream
    const stream = streamToPacketStream(transport)
    const input = pushable<Uint8Array>({ objectMode: true })
    input.push(new Uint8Array([1]))
    const pending = stream.sink(input)
    await sinkStarted.promise

    await stream.close()

    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects a blocked packet sink with the abort error', async () => {
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream() {},
    })

    try {
      const stream = await clientConn.openStream()
      const input = pushable<Uint8Array>({ objectMode: true })
      const pending = stream.sink(input)
      const error = new Error('stopped')

      stream.abort(error)

      await expect(pending).rejects.toBe(error)
    } finally {
      cleanup()
    }
  })

  it('does not write ready input after close', async () => {
    const serverStream = Promise.withResolvers<PacketStream>()
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream(stream) {
        serverStream.resolve(stream)
      },
    })

    try {
      const stream = await clientConn.openStream()
      const peer = await serverStream.promise
      const input = pushable<Uint8Array>({ objectMode: true })
      input.push(new Uint8Array([1]))

      const pending = stream.sink(input)
      await stream.close()

      await expect(pending).resolves.toBeUndefined()
      await expect(nextWithTimeout(peer.source, 'server eof')).resolves.toEqual(
        {
          done: true,
          value: undefined,
        },
      )
    } finally {
      cleanup()
    }
  })

  it('aborts the yamux stream when the packet source errors', async () => {
    const request = new TextEncoder().encode('request')
    const sourceError = new Error('source failed')
    let resolveReset: (err: unknown) => void = () => {}
    const resetSeen = new Promise<unknown>((resolve) => {
      resolveReset = resolve
    })
    const { clientConn, cleanup } = connectStreamConns({
      handlePacketStream(stream: PacketStream) {
        void (async () => {
          try {
            for await (const _packet of stream.source) {
              // Drain until the reset arrives.
            }
            resolveReset(new Error('server stream ended without reset'))
          } catch (err) {
            resolveReset(err)
          }
        })()
      },
    })

    try {
      const clientStream = await clientConn.openStream()
      await expect(
        clientStream.sink(
          (async function* () {
            yield request
            throw sourceError
          })(),
        ),
      ).rejects.toThrow('source failed')

      const resetErr = await promiseWithTimeout(resetSeen, 'server reset')
      expect(resetErr).toBeInstanceOf(Error)
      expect((resetErr as Error).message).toBe('stream reset')
    } finally {
      cleanup()
    }
  })
})

function connectStreamConns(server: StreamHandler): {
  clientConn: StreamConn
  cleanup: () => void
} {
  const clientConn = new StreamConn()
  const serverConn = new StreamConn(server, { direction: 'inbound' })

  const { port1: clientPort, port2: serverPort } = new MessageChannel()
  const opts: ChannelStreamOpts = {}
  const clientChannelStream = new ChannelStream('client', clientPort, opts)
  const serverChannelStream = new ChannelStream('server', serverPort, opts)

  pipe(
    clientChannelStream,
    clientConn,
    combineUint8ArrayListTransform(),
    clientChannelStream,
  )
    .catch((err: Error) => clientConn.close(err))
    .then(() => clientConn.close())

  pipe(
    serverChannelStream,
    serverConn,
    combineUint8ArrayListTransform(),
    serverChannelStream,
  )
    .catch((err: Error) => serverConn.close(err))
    .then(() => serverConn.close())

  return {
    clientConn,
    cleanup() {
      clientConn.close()
      serverConn.close()
      clientChannelStream.close()
      serverChannelStream.close()
    },
  }
}

async function nextWithTimeout<T>(
  source: AsyncIterator<T>,
  label: string,
): Promise<IteratorResult<T>> {
  return promiseWithTimeout(source.next(), label)
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 500)
    }),
  ])
}
