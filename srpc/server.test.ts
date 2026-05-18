import { describe, it, beforeEach, expect, vi } from 'vitest'
import { pipe } from 'it-pipe'
import {
  createHandler,
  createMux,
  Server,
  Client,
  StreamConn,
  ChannelStream,
  combineUint8ArrayListTransform,
  ChannelStreamOpts,
  Packet,
} from '../srpc/index.js'
import {
  EchoerDefinition,
  EchoerServer,
  EchoerServiceName,
  runClientTest,
} from '../echo/index.js'
import {
  runAbortControllerTest,
  runRpcStreamTest,
} from '../echo/client-test.js'

describe('srpc server', () => {
  let client: Client

  beforeEach(async () => {
    const mux = createMux()
    const server = new Server(mux.lookupMethod)
    const echoer = new EchoerServer(server)
    mux.register(createHandler(EchoerDefinition, echoer))

    // StreamConn is unnecessary since ChannelStream has packet framing.
    // Use it here to include yamux in this e2e test.
    const clientConn = new StreamConn()
    const serverConn = new StreamConn(server, { direction: 'inbound' })

    // pipe clientConn -> messageStream -> serverConn -> messageStream -> clientConn
    const { port1: clientPort, port2: serverPort } = new MessageChannel()
    const opts: ChannelStreamOpts = {} // { idleTimeoutMs: 250, keepAliveMs: 100 }
    const clientChannelStream = new ChannelStream('client', clientPort, opts)
    const serverChannelStream = new ChannelStream('server', serverPort, opts)

    // Pipe the client traffic via the client end of the MessageChannel.
    pipe(
      clientChannelStream,
      clientConn,
      combineUint8ArrayListTransform(),
      clientChannelStream,
    )
      .catch((err: Error) => clientConn.close(err))
      .then(() => clientConn.close())

    // Pipe the server traffic via the server end of the MessageChannel.
    pipe(
      serverChannelStream,
      serverConn,
      combineUint8ArrayListTransform(),
      serverChannelStream,
    )
      .catch((err: Error) => serverConn.close(err))
      .then(() => serverConn.close())

    // Build the client
    client = new Client(clientConn.buildOpenStreamFunc())
  })

  it('should pass client tests', async () => {
    await runClientTest(client)
  })

  it('should pass abort controller tests', async () => {
    await runAbortControllerTest(client)
  })

  it('should pass rpc stream tests', async () => {
    await runRpcStreamTest(client)
  })

  it('keeps detached server-streaming responses open after request source completes', async () => {
    const mux = createMux()
    const response = new TextEncoder().encode('delayed init')
    mux.registerLookupMethod(async (service, method) => {
      if (service !== 'test.ResourceService' || method !== 'ResourceClient') {
        return null
      }
      return async (_dataSource, dataSink) => {
        await dataSink(
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 10))
            yield response
          })(),
        )
      }
    })

    const server = new Server(mux.lookupMethod)
    const firstResponse = new Promise<Packet>((resolve, reject) => {
      server.handlePacketStream({
        source: (async function* () {
          yield Packet.toBinary({
            body: {
              case: 'callStart',
              value: {
                rpcService: 'test.ResourceService',
                rpcMethod: 'ResourceClient',
                data: new Uint8Array(0),
                dataIsZero: true,
              },
            },
          })
        })(),
        sink: async (source) => {
          try {
            for await (const packetData of source) {
              const packet = Packet.fromBinary(packetData)
              if (packet.body?.case === 'callData') {
                resolve(packet)
                return
              }
            }
            reject(new Error('server response stream ended before call data'))
          } catch (err) {
            reject(err as Error)
          }
        },
      })
    })

    const packet = await promiseWithTimeout(
      firstResponse,
      'detached server-streaming response',
    )
    const body = packet.body
    expect(body?.case).toBe('callData')
    if (body?.case !== 'callData' || !body.value?.data) {
      throw new Error('expected callData packet')
    }
    expect([...body.value.data]).toEqual([...response])
  })

  it('keeps StreamConn server-streaming responses open after Go-style request close', async () => {
    const mux = createMux()
    const response = new TextEncoder().encode('streamconn init')
    mux.registerLookupMethod(async (service, method) => {
      if (service !== 'test.ResourceService' || method !== 'ResourceClient') {
        return null
      }
      return async (_dataSource, dataSink) => {
        await dataSink(
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 10))
            yield response
          })(),
        )
      }
    })

    const server = new Server(mux.lookupMethod)
    const clientConn = new StreamConn()
    const serverConn = new StreamConn(server, { direction: 'inbound' })
    const { port1: clientPort, port2: serverPort } = new MessageChannel()
    const clientChannelStream = new ChannelStream('client', clientPort)
    const serverChannelStream = new ChannelStream('server', serverPort)

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

    try {
      const stream = await clientConn.openStream()
      const firstResponse = (async () => {
        for await (const packetData of stream.source) {
          const packet = Packet.fromBinary(packetData)
          if (packet.body?.case === 'callData') {
            return packet
          }
        }
        throw new Error('server response stream ended before call data')
      })()

      await stream.sink(
        (async function* () {
          yield Packet.toBinary({
            body: {
              case: 'callStart',
              value: {
                rpcService: 'test.ResourceService',
                rpcMethod: 'ResourceClient',
                data: new Uint8Array(0),
                dataIsZero: true,
              },
            },
          })
        })(),
      )

      const packet = await promiseWithTimeout(
        firstResponse,
        'StreamConn server-streaming response',
      )
      const body = packet.body
      expect(body?.case).toBe('callData')
      if (body?.case !== 'callData' || !body.value?.data) {
        throw new Error('expected callData packet')
      }
      expect([...body.value.data]).toEqual([...response])
    } finally {
      clientConn.close()
      serverConn.close()
      clientChannelStream.close()
      serverChannelStream.close()
    }
  })

  it('removes abort listeners after a request completes', async () => {
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(
      controller.signal,
      'removeEventListener',
    )

    await client.request(
      EchoerServiceName,
      'Echo',
      new TextEncoder().encode('hello'),
      controller.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    )
  })

  it('tears down passive channel close state', async () => {
    const { port1, port2 } = new MessageChannel()
    const opts: ChannelStreamOpts = { idleTimeoutMs: 1000, keepAliveMs: 1000 }
    const active = new ChannelStream('active', port1, opts)
    const passive = new ChannelStream('passive', port2, opts)
    const next = passive.source[Symbol.asyncIterator]().next()

    active.close()
    await expect(next).resolves.toEqual({ done: true, value: undefined })

    expect((passive as any).closed).toBe(true)
    expect((passive as any).idleWatchdog).toBeUndefined()
    expect((passive as any).keepAlive).toBeUndefined()
    expect(port2.onmessage).toBe(null)
  })
})

function promiseWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 100)
    }),
  ])
}
