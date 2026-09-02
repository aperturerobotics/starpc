import net from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pushable } from 'it-pushable'

import { tcpSocketToPacketStream } from './tcp-packet-stream.js'

const sockets: net.Socket[] = []
const servers: net.Server[] = []

afterEach(() => {
  for (const socket of sockets) socket.destroy()
  for (const server of servers) server.close()
  sockets.length = 0
  servers.length = 0
})

describe('TCP PacketStream lifecycle', () => {
  it('settles a blocked source when the peer ends cleanly', async () => {
    const { local, peer } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const pending = stream.source.next()

    peer.end()

    await expect(settleBeforeTimeout(pending)).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it('reports a truncated frame when the peer ends', async () => {
    const { local, peer } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const pending = stream.source.next()

    peer.end(Buffer.from([4, 0, 0, 0, 10, 1]))

    await expect(settleBeforeTimeout(pending)).rejects.toThrow(
      'truncated packet frame',
    )
  })

  it('rejects a blocked source with the abort error', async () => {
    const { local } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const pending = stream.source.next()
    const error = new Error('stopped')

    stream.abort(error)

    await expect(settleBeforeTimeout(pending)).rejects.toBe(error)
  })

  it('settles a blocked sink when closed', async () => {
    const { local } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const input = pushable<Uint8Array>({ objectMode: true })
    const pending = stream.sink(input)

    await stream.close()

    await expect(pending).resolves.toBeUndefined()
  })

  it('settles an in-flight socket write when closed', async () => {
    const { local } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const input = pushable<Uint8Array>({ objectMode: true })
    const writeStarted = Promise.withResolvers<void>()
    vi.spyOn(local, 'write').mockImplementation(((
      _data: Uint8Array,
      _callback: (error?: Error) => void,
    ) => {
      writeStarted.resolve()
      return true
    }) as typeof local.write)
    input.push(new Uint8Array([1]))
    const pending = stream.sink(input)
    await writeStarted.promise

    await stream.close()

    await expect(settleBeforeTimeout(pending)).resolves.toBeUndefined()
  })

  it('rejects a blocked sink with the abort error', async () => {
    const { local } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const input = pushable<Uint8Array>({ objectMode: true })
    const pending = stream.sink(input)
    const error = new Error('stopped')

    stream.abort(error)

    await expect(pending).rejects.toBe(error)
  })

  it('does not write ready input after close', async () => {
    const { local, peer } = await connectSockets()
    const stream = tcpSocketToPacketStream(local)
    const input = pushable<Uint8Array>({ objectMode: true })
    const received: Buffer[] = []
    peer.on('data', (data) => {
      if (typeof data !== 'string') received.push(data)
    })
    input.push(new Uint8Array([1]))

    const pending = stream.sink(input)
    await stream.close()
    await pending
    await new Promise<void>((resolve) => peer.once('close', () => resolve()))

    expect(received).toEqual([])
  })
})

async function connectSockets(): Promise<{
  local: net.Socket
  peer: net.Socket
}> {
  const accepted = Promise.withResolvers<net.Socket>()
  const server = net.createServer((socket) => accepted.resolve(socket))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as net.AddressInfo
  const local = net.connect(address.port, address.address)
  await new Promise<void>((resolve, reject) => {
    local.once('connect', resolve)
    local.once('error', reject)
  })
  const peer = await accepted.promise
  sockets.push(local, peer)
  return { local, peer }
}

async function settleBeforeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('source stayed blocked')),
          500,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
