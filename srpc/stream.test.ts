import { describe, expect, it } from 'vitest'
import { pipe } from 'it-pipe'

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
